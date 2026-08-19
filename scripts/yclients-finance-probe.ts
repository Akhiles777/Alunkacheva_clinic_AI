/**
 * Что YCLIENTS отдаёт по деньгам и сходится ли это с нашей выручкой.
 *
 * Заказчик спрашивает: можно ли брать выручку за день прямо из YCLIENTS, а не
 * складывать её из визитов. Ответ зависит от двух вещей, и обе надо увидеть, а
 * не предположить:
 *
 *   1. Отдаёт ли их API финансовые операции этому филиалу и под этим токеном.
 *      Раздел «Финансы» — отдельные права, у клиники они могут быть не выданы.
 *   2. Насколько касса расходится с нашей выручкой. Это РАЗНЫЕ величины:
 *      выручка — стоимость услуг состоявшегося визита (§8), касса — деньги,
 *      прошедшие через кассу, вместе с предоплатами, абонементами и
 *      возвратами. Подменять одно другим нельзя; можно показать рядом.
 *
 * Ничего не меняет. Имён и телефонов не печатает (§7): только суммы и даты.
 *
 *   npx tsx scripts/yclients-finance-probe.ts
 *   npx tsx scripts/yclients-finance-probe.ts --days=14
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { getYclientsClient } from "../lib/integrations/yclients/client";
import { apiDate } from "../lib/integrations/yclients/paging";
import { revenueByDay } from "../lib/server/daily-revenue";

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = Number(daysArg?.slice(7) ?? 30);
const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;

/** Дата операции в зоне клиники: у YCLIENTS формат «2026-08-18 14:30:00». */
function dayOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  return m ? m[1] : null;
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  const now = new Date();
  const from = new Date(now.getTime() - DAYS * 24 * 3600 * 1000);
  console.log(`клиника: ${company.name}`);
  console.log(`период: ${apiDate(from)} — ${apiDate(now)}\n`);

  const client = await getYclientsClient(company.id);
  if (!client) {
    console.log("YCLIENTS выключен или не заданы ключи.");
    await prisma.$disconnect();
    return;
  }

  // ── 1. Что отвечает раздел финансов
  console.log("── запрос финансовых операций ──");
  let rows: Record<string, unknown>[] = [];
  try {
    const res = await client.getPage<Record<string, unknown>[]>(
      client.endpoints.transactions(client.creds.companyId),
      { start_date: apiDate(from), end_date: apiDate(now), count: 1000 },
    );
    rows = Array.isArray(res.data) ? res.data : [];
    console.log(`  ответ получен, операций: ${rows.length}`);
  } catch (e) {
    console.log(`  ОТКАЗ: ${(e as Error)?.message ?? e}`);
    console.log(
      "\n  Скорее всего у токена нет прав на раздел «Финансы» — их выдают\n" +
        "  отдельно в YCLIENTS. Пока их нет, брать кассу неоткуда.",
    );
    await prisma.$disconnect();
    return;
  }

  if (rows.length === 0) {
    console.log("  операций за период нет — либо касса не ведётся, либо период пуст.");
    await prisma.$disconnect();
    return;
  }

  // ── 2. Из чего состоит операция
  console.log("\n── поля операции (по первой записи) ──");
  const sample = rows[0];
  for (const [k, v] of Object.entries(sample)) {
    const shown =
      v === null || typeof v !== "object" ? String(v).slice(0, 40) : `{${Object.keys(v).join(", ")}}`;
    console.log(`  ${k}: ${shown}`);
  }

  // ── 3. Касса по дням против нашей выручки
  const amountKey = ["amount", "sum", "cost"].find((k) => k in sample) ?? "amount";
  const dateKey = ["date", "create_date", "datetime"].find((k) => k in sample) ?? "date";
  console.log(`\n  сумму берём из «${amountKey}», дату из «${dateKey}»`);

  const cashByDay = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    const day = dayOf(r[dateKey]);
    if (!day) continue;
    const acc = cashByDay.get(day) ?? { sum: 0, count: 0 };
    acc.sum += num(r[amountKey]);
    acc.count += 1;
    cashByDay.set(day, acc);
  }

  const ours = await revenueByDay(company.id, DAYS, now, 0);
  console.log("\n── касса YCLIENTS против нашей выручки ──");
  console.log("   наша выручка — стоимость услуг состоявшихся визитов (§8)");
  console.log("   касса — деньги, прошедшие через кассу: предоплаты, абонементы, возвраты\n");

  let cashTotal = 0;
  let oursTotal = 0;
  for (const d of ours) {
    const cash = cashByDay.get(d.date);
    if (!cash && d.revenue === 0) continue;
    cashTotal += cash?.sum ?? 0;
    oursTotal += d.revenue;
    const diff = (cash?.sum ?? 0) - d.revenue;
    console.log(
      `  ${d.date}: касса ${money(cash?.sum ?? 0)} (${cash?.count ?? 0} операций) · ` +
        `у нас ${money(d.revenue)} (${d.arrived} приёмов)` +
        `${diff !== 0 ? ` · разница ${money(diff)}` : " · совпало"}`,
    );
  }
  console.log(`\n  итого касса ${money(cashTotal)} · наша выручка ${money(oursTotal)}`);
  console.log(
    cashTotal === oursTotal
      ? "  величины совпали — тогда кассу можно брать напрямую"
      : `  расхождение ${money(cashTotal - oursTotal)} — это разные величины, и подменять\n` +
          "  одну другой нельзя. Показывать их можно только рядом.",
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
