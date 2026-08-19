/**
 * Из чего сложилась выручка дня — по каждому визиту.
 *
 * Клиника называет за день 43 480 ₽, платформа показывает 61 280 ₽. Спорить
 * итогами бесполезно: нужно разложить день на визиты и увидеть, какие рубли
 * лишние.
 *
 * Главный подозреваемый — подстановка цены. Когда в записи YCLIENTS стоимость
 * не проставлена, мы берём цену услуги (§8). Но у сеанса курса стоимость
 * нулевая законно: деньги клиника получила при продаже курса, а не сегодня.
 * Подставляя цену такому сеансу, платформа считает одни и те же деньги дважды.
 *
 * Скрипт показывает итог с подстановкой и без неё — и сравнивает с числом,
 * которое называет клиника.
 *
 *   npx tsx scripts/day-revenue.ts --day=2026-08-19
 *   npx tsx scripts/day-revenue.ts --day=2026-08-19 --expect=43480
 */
import "dotenv/config";
import { prisma } from "../lib/db";

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;

async function main() {
  const day = arg("day") ?? new Date().toISOString().slice(0, 10);
  const expect = arg("expect") ? Number(arg("expect")) : null;

  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  const start = new Date(`${day}T00:00:00+03:00`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);

  const rows = await prisma.appointment.findMany({
    where: { companyId: company.id, deletedAt: null, status: "ARRIVED", startAt: { gte: start, lt: end } },
    orderBy: { startAt: "asc" },
    select: {
      yclientsRecordId: true,
      startAt: true,
      revenue: true,
      revenueSource: true,
      staff: { select: { name: true } },
      primaryService: { select: { title: true } },
    },
  });

  console.log(`клиника: ${company.name}`);
  console.log(`день: ${day}, состоявшихся приёмов: ${rows.length}\n`);
  console.log("── приёмы дня ──");
  for (const r of rows) {
    console.log(
      `  ${r.startAt.toISOString().slice(11, 16)} · ${r.primaryService?.title ?? "услуга не указана"}` +
        ` · ${r.staff?.name ?? "—"} · ${money(Number(r.revenue))} · ${r.revenueSource}` +
        ` · запись ${r.yclientsRecordId ?? "—"}`,
    );
  }

  const total = rows.reduce((s, r) => s + Number(r.revenue), 0);
  // Строки старого правила: цена подставлена из прайса. После полного перечёта
  // их не остаётся, и оба итога ниже совпадают.
  const substituted = rows.filter((r) => r.revenueSource === "PRICE_LIST");
  const subSum = substituted.reduce((s, r) => s + Number(r.revenue), 0);
  const fromRecords = total - subSum;
  const courseSessions = rows.filter((r) => r.revenueSource === "PREPAID");
  const missing = rows.filter((r) => r.revenueSource === "UNKNOWN");

  console.log("\n── итоги дня ──");
  console.log(`  всего у нас:                 ${money(total)}`);
  console.log(`  из них стоимость из записи:  ${money(fromRecords)} (${rows.length - substituted.length} приёмов)`);
  console.log(`  подставлено из прайса:       ${money(subSum)} (${substituted.length} приёмов)`);
  console.log(`  сеансов по курсу:            ${courseSessions.length} — денег дня не дают, оплачены при продаже`);
  console.log(`  цена не проставлена:         ${missing.length} — правится в YCLIENTS`);

  if (substituted.length > 0) {
    console.log("\n  подставленные приёмы:");
    const byService = new Map<string, { n: number; sum: number }>();
    for (const r of substituted) {
      const key = r.primaryService?.title ?? "услуга не указана";
      const acc = byService.get(key) ?? { n: 0, sum: 0 };
      acc.n += 1;
      acc.sum += Number(r.revenue);
      byService.set(key, acc);
    }
    for (const [title, v] of [...byService.entries()].sort((a, b) => b[1].sum - a[1].sum)) {
      console.log(`      ${title}: ${v.n} × = ${money(v.sum)}`);
    }
  }

  if (expect !== null) {
    console.log(`\n── сравнение с числом клиники (${money(expect)}) ──`);
    const diffAll = total - expect;
    const diffNoSub = fromRecords - expect;
    console.log(`  с подстановкой:  ${money(total)} · разница ${money(diffAll)}`);
    console.log(`  без подстановки: ${money(fromRecords)} · разница ${money(diffNoSub)}`);
    if (diffNoSub === 0) {
      console.log(
        "\n  ✓ СОВПАЛО без подстановки. Значит клиника не считает выручкой сеансы,\n" +
          "    у которых в записи стоит ноль: деньги по ним получены раньше\n" +
          "    (курс, абонемент). Подстановка цены удваивает эти рубли.",
      );
    } else if (diffAll === 0) {
      console.log("\n  ✓ совпало с подстановкой — считаем верно.");
    } else {
      console.log("\n  ✗ не совпало ни так, ни так — причина в чём-то ещё, нужен разбор по приёмам выше.");
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
