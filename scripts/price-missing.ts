/**
 * Визиты, где цену подставили за клинику.
 *
 * Стоимость услуги в YCLIENTS проставляет администратор. Когда он этого не
 * сделал, выручка визита нулевая — а приём состоялся, и §8 говорит считать его
 * по цене услуги. Мы так и делаем, но это подстановка, а не касса: владелец
 * должен видеть, за какие именно приёмы платформа посчитала деньги сама.
 *
 * Отдельно — визиты, где цену взять неоткуда вовсе: ни стоимости, ни цены по
 * прайсу. Они считаются нулём, и это тоже надо видеть.
 *
 * Ничего не меняет. Имён и телефонов не печатает (§7): каждая строка помечена
 * номером записи YCLIENTS — по нему владелец откроет её у себя и проверит.
 *
 *   npx tsx scripts/price-missing.ts                 — за 90 дней
 *   npx tsx scripts/price-missing.ts --days=365
 *   npx tsx scripts/price-missing.ts --all           — за всю историю
 *   npx tsx scripts/price-missing.ts --csv > out.csv — таблицей
 */
import "dotenv/config";
import { prisma } from "../lib/db";

const CSV = process.argv.includes("--csv");
const ALL = process.argv.includes("--all");
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = Number(daysArg?.slice(7) ?? 90);

const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;
const day = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);

async function main() {
  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  const from = ALL ? new Date(0) : new Date(Date.now() - DAYS * 24 * 3600 * 1000);

  const rows = await prisma.appointment.findMany({
    where: {
      companyId: company.id,
      deletedAt: null,
      status: "ARRIVED",
      revenueSource: { in: ["PRICE_LIST", "UNKNOWN"] },
      startAt: { gte: from },
    },
    orderBy: { startAt: "desc" },
    select: {
      yclientsRecordId: true,
      startAt: true,
      revenue: true,
      revenueSource: true,
      staff: { select: { name: true } },
      primaryService: { select: { title: true } },
    },
  });

  if (CSV) {
    console.log("Запись YCLIENTS;Дата;Специалист;Услуга;Подставлено;Основание");
    for (const r of rows) {
      const why = r.revenueSource === "PRICE_LIST" ? "цена по прайсу" : "цены нет нигде";
      console.log(
        [
          r.yclientsRecordId ?? "",
          day(r.startAt),
          r.staff?.name ?? "",
          r.primaryService?.title ?? "услуга не указана",
          Math.round(Number(r.revenue)),
          why,
        ].join(";"),
      );
    }
    await prisma.$disconnect();
    return;
  }

  console.log(`клиника: ${company.name}`);
  console.log(ALL ? "период: вся история\n" : `период: последние ${DAYS} дней\n`);

  const substituted = rows.filter((r) => r.revenueSource === "PRICE_LIST");
  const unknown = rows.filter((r) => r.revenueSource === "UNKNOWN");

  /**
   * Сначала свод по услугам: владельцу важно не «сто строк», а «в остеопатии
   * стоимость не проставляют чаще всего». Одна строка сразу называет и услугу,
   * и подставленную цену — по ней видно, та ли это цена.
   */
  console.log("── цену подставили из прайса ──");
  const byService = new Map<string, { n: number; sum: number; prices: Set<number> }>();
  for (const r of substituted) {
    const key = r.primaryService?.title ?? "услуга не указана";
    const acc = byService.get(key) ?? { n: 0, sum: 0, prices: new Set<number>() };
    acc.n += 1;
    acc.sum += Number(r.revenue);
    acc.prices.add(Math.round(Number(r.revenue)));
    byService.set(key, acc);
  }
  for (const [title, v] of [...byService.entries()].sort((a, b) => b[1].sum - a[1].sum)) {
    const prices = [...v.prices].sort((a, b) => a - b).map((p) => money(p)).join(", ");
    console.log(`  ${title}: ${v.n} приёмов на ${money(v.sum)} (по ${prices})`);
  }
  console.log(`  всего: ${substituted.length} приёмов на ${money(substituted.reduce((s, r) => s + Number(r.revenue), 0))}\n`);

  console.log("── по приёмам (номер записи открывается в YCLIENTS) ──");
  for (const r of substituted.slice(0, 200)) {
    console.log(
      `  ${r.yclientsRecordId} · ${day(r.startAt)} · ${r.staff?.name ?? "—"} · ` +
        `${r.primaryService?.title ?? "услуга не указана"} · подставлено ${money(Number(r.revenue))}`,
    );
  }
  if (substituted.length > 200) {
    console.log(`  …и ещё ${substituted.length - 200}. Полный список: --csv > out.csv`);
  }

  if (unknown.length > 0) {
    console.log("\n── цену взять неоткуда: считаются нулём ──");
    console.log("  Ни стоимости в записи, ни цены услуги по прайсу. Выручки по ним нет.");
    for (const r of unknown.slice(0, 50)) {
      console.log(
        `  ${r.yclientsRecordId} · ${day(r.startAt)} · ${r.staff?.name ?? "—"} · ` +
          `${r.primaryService?.title ?? "услуга не указана"}`,
      );
    }
    if (unknown.length > 50) console.log(`  …и ещё ${unknown.length - 50}`);
  }

  console.log(
    "\nЧто проверить владельцу: у этих приёмов стоимость в YCLIENTS не проставлена,\n" +
      "и скидки на них нет. Если приём был платным — подставленная цена верна.\n" +
      "Если он был бесплатным, в YCLIENTS нужно поставить скидку 100%: тогда\n" +
      "платформа перестанет считать по нему выручку.",
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
