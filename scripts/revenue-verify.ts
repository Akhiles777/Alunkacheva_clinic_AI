/**
 * Сверка выручки с YCLIENTS: пересчёт заново и сравнение с базой.
 *
 * Числа на экране можно проверять двумя способами — посмотреть и поверить или
 * пересчитать из первоисточника и сравнить. Первый уже подвёл: правило про
 * бесплатные услуги выглядело правдоподобно и обнулило три миллиона рублей.
 *
 * Скрипт берёт записи YCLIENTS за период, считает стоимость каждой той же
 * функцией, что и выгрузка, и сравнивает с тем, что лежит у нас. Расхождение
 * означает одно из двух: выгрузка не доехала или считает не то. И то и другое
 * надо видеть числом, а не подозревать.
 *
 * Ничего не меняет. Персональные данные не печатаются.
 *
 *   npx tsx scripts/revenue-verify.ts              — последние 30 дней
 *   npx tsx scripts/revenue-verify.ts --days=90
 *   npx tsx scripts/revenue-verify.ts --month=2026-08
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { getYclientsClient } from "../lib/integrations/yclients/client";
import { apiDate, hasNextPage, monthWindows, PAGE_SIZE } from "../lib/integrations/yclients/paging";
import { mapRecordStatus, recordRevenue } from "../lib/integrations/yclients/mappers";
import type { YclientsRecord } from "../lib/integrations/yclients/types";

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;

async function main() {
  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });

  const month = arg("month");
  const days = Number(arg("days") ?? 30);
  const now = new Date();
  const from = month
    ? new Date(`${month}-01T00:00:00+03:00`)
    : new Date(now.getTime() - days * 24 * 3600 * 1000);
  const to = month
    ? new Date(new Date(`${month}-01T00:00:00+03:00`).setMonth(from.getMonth() + 1))
    : now;

  console.log(`клиника: ${company.name}`);
  console.log(`период: ${apiDate(from)} — ${apiDate(to)}\n`);

  const client = await getYclientsClient(company.id);
  if (!client) {
    console.log("YCLIENTS выключен или не заданы ключи — сверять не с чем.");
    return;
  }

  /** Что говорит YCLIENTS: номер записи → ожидаемая стоимость и статус. */
  const expected = new Map<number, { amount: number; source: string; arrived: boolean }>();

  for (const window of monthWindows(from, to)) {
    let page = 1;
    let fetched = 0;
    for (;;) {
      const res = await client.getPage<YclientsRecord[]>(
        client.endpoints.records(client.creds.companyId),
        { start_date: apiDate(window.from), end_date: apiDate(window.to), page, count: PAGE_SIZE },
      );
      const dtos = res.data ?? [];
      for (const dto of dtos) {
        if (dto.deleted) continue;
        const at = new Date(dto.datetime);
        if (at < from || at >= to) continue;
        const rev = recordRevenue(dto);
        expected.set(dto.id, {
          amount: rev.amount,
          source: rev.source,
          // Тем же правилом, что и выгрузка: будущий визит состояться не мог.
          arrived: mapRecordStatus(dto.visit_attendance, dto.deleted, at) === "ARRIVED",
        });
      }
      fetched += dtos.length;
      if (!hasNextPage({ received: dtos.length, pageSize: PAGE_SIZE, fetchedSoFar: fetched, totalCount: res.totalCount, page })) break;
      page += 1;
    }
  }

  const ours = await prisma.appointment.findMany({
    where: { companyId: company.id, deletedAt: null, startAt: { gte: from, lt: to } },
    select: { yclientsRecordId: true, status: true, revenue: true, revenueSource: true, primaryServiceId: true },
  });
  const byId = new Map(ours.filter((a) => a.yclientsRecordId !== null).map((a) => [a.yclientsRecordId as number, a]));

  // ── Итоги
  const remoteArrived = [...expected.values()].filter((e) => e.arrived);
  const remoteMoney = remoteArrived.reduce((s, e) => s + e.amount, 0);
  const ourArrived = ours.filter((a) => a.status === "ARRIVED");
  const ourMoney = ourArrived.reduce((s, a) => s + Number(a.revenue), 0);

  console.log("── пришедшие и выручка ──");
  console.log(`  YCLIENTS: ${remoteArrived.length} визитов, ${money(remoteMoney)}`);
  console.log(`  у нас:    ${ourArrived.length} визитов, ${money(ourMoney)}`);
  const diff = ourMoney - remoteMoney;
  console.log(
    diff === 0
      ? "  расхождения нет"
      : `  РАСХОЖДЕНИЕ: ${money(Math.abs(diff))} ${diff > 0 ? "у нас больше" : "у нас меньше"}`,
  );

  // ── Построчно
  console.log("\n── по записям ──");
  let missing = 0;
  let extra = 0;
  const wrong: { id: number; ours: number; theirs: number; source: string }[] = [];

  for (const [id, e] of expected) {
    const own = byId.get(id);
    if (!own) {
      missing += 1;
      continue;
    }
    /**
     * Сравниваем только те, где стоимость посчитана самой записью или
     * подарена. Подстановку из справочника скрипт повторить не может — цену
     * он не читает, — и её расхождение расхождением не является.
     */
    if (e.source === "UNKNOWN" || own.revenueSource === "UNKNOWN") continue;
    if (e.source === "PRICE_LIST" && own.revenueSource === "PRICE_LIST" && e.amount === 0) continue;
    if (Math.abs(Number(own.revenue) - e.amount) > 0.005) {
      wrong.push({ id, ours: Number(own.revenue), theirs: e.amount, source: `${own.revenueSource}/${e.source}` });
    }
  }
  for (const a of ours) {
    if (a.yclientsRecordId !== null && !expected.has(a.yclientsRecordId)) extra += 1;
  }

  console.log(`  есть в YCLIENTS, нет у нас: ${missing}`);
  console.log(`  есть у нас, нет в YCLIENTS: ${extra}  ← это отменённые там, их снимает сверка`);
  console.log(`  стоимость не совпала: ${wrong.length}`);
  for (const w of wrong.slice(0, 10)) {
    console.log(`      запись ${w.id}: у нас ${money(w.ours)}, по YCLIENTS ${money(w.theirs)} (${w.source})`);
  }

  // ── Откуда суммы за период
  console.log("\n── откуда суммы за период ──");
  const bySource = new Map<string, { n: number; sum: number }>();
  for (const a of ourArrived) {
    const acc = bySource.get(a.revenueSource) ?? { n: 0, sum: 0 };
    acc.n += 1;
    acc.sum += Number(a.revenue);
    bySource.set(a.revenueSource, acc);
  }
  for (const [src, v] of [...bySource.entries()].sort()) {
    console.log(`  ${src}: ${v.n} визитов, ${money(v.sum)}`);
  }
  const noService = ourArrived.filter((a) => a.primaryServiceId === null).length;
  if (noService > 0) {
    console.log(`  визитов без услуги: ${noService} — по ним цену подставить неоткуда`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
