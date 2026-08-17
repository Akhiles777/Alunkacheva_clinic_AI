/**
 * Откуда берётся выручка и где она врёт.
 *
 * Написан на жалобу «по Ирине Омаровой выручка неправильная». Выручка визита —
 * стоимость услуг из записи YCLIENTS, и разойтись с действительностью она может
 * в нескольких местах сразу:
 *
 *   1. Визит состоялся, а стоимость в записи ноль. Так бывает у абонементов:
 *      пациент оплатил курс одним платежом, и отдельные сеансы идут по нулю.
 *      Тогда выручка специалиста, который ведёт курсы, занижена в разы.
 *   2. Стоимость в записи отличается от цены услуги в справочнике — скидка,
 *      наценка или просто другая услуга внутри записи.
 *   3. У визита нет основной услуги, и он не попадает в разрез по услугам.
 *
 * Скрипт показывает всё это по каждому специалисту и по каждой услуге:
 * сколько визитов, сколько из них с нулевой стоимостью и насколько средний
 * чек расходится с ценой из справочника.
 *
 * Персональные данные не печатаются.
 *
 *   npx tsx scripts/revenue-audit.ts                # за 90 дней
 *   npx tsx scripts/revenue-audit.ts --days=365
 *   npx tsx scripts/revenue-audit.ts --staff=Омарова
 */
import "dotenv/config";
import { prisma } from "../lib/db";

const money = (v: number) => `${Math.round(v).toLocaleString("ru-RU")} ₽`;

function daysArg(): number {
  const raw = process.argv.find((a) => a.startsWith("--days="))?.split("=")[1];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 90;
}

async function main() {
  const days = daysArg();
  const staffFilter = process.argv.find((a) => a.startsWith("--staff="))?.split("=")[1];
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const from = new Date(Date.now() - days * 24 * 3600 * 1000);

  console.log(`клиника: ${company.name}, период: последние ${days} дней`);

  const appts = await prisma.appointment.findMany({
    where: {
      companyId: company.id,
      deletedAt: null,
      status: "ARRIVED",
      startAt: { gte: from },
      ...(staffFilter ? { staff: { name: { contains: staffFilter, mode: "insensitive" } } } : {}),
    },
    select: {
      revenue: true,
      isPaid: true,
      courseId: true,
      startAt: true,
      staff: { select: { name: true, specialty: true } },
      primaryService: { select: { title: true, price: true } },
    },
  });

  console.log(`состоявшихся визитов: ${appts.length}`);
  if (appts.length === 0) {
    await prisma.$disconnect();
    return;
  }

  // ── По специалистам
  const byStaff = new Map<string, typeof appts>();
  for (const a of appts) {
    const key = a.staff?.name ?? "(без специалиста)";
    const list = byStaff.get(key) ?? [];
    list.push(a);
    byStaff.set(key, list);
  }

  console.log(`\n═══ ПО СПЕЦИАЛИСТАМ ═══`);
  console.log(
    `  ${"специалист".padEnd(26)} ${"визитов".padStart(8)} ${"с нулём".padStart(8)} ` +
      `${"выручка".padStart(14)} ${"чек".padStart(10)}`,
  );
  for (const [name, list] of [...byStaff].sort((a, b) => b[1].length - a[1].length)) {
    const revenue = list.reduce((sum, a) => sum + Number(a.revenue), 0);
    const zero = list.filter((a) => Number(a.revenue) === 0).length;
    const avg = list.length ? revenue / list.length : 0;
    const flag = zero > list.length * 0.2 ? "  ← выручка занижена: много визитов по нулю" : "";
    console.log(
      `  ${name.slice(0, 25).padEnd(26)} ${String(list.length).padStart(8)} ` +
        `${String(zero).padStart(8)} ${money(revenue).padStart(14)} ${money(avg).padStart(10)}${flag}`,
    );
  }

  // ── По услугам: сверка с ценой из справочника
  const byService = new Map<string, { visits: number; revenue: number; zero: number; price: number }>();
  let noService = 0;
  for (const a of appts) {
    if (!a.primaryService) {
      noService += 1;
      continue;
    }
    const key = a.primaryService.title;
    const row = byService.get(key) ?? { visits: 0, revenue: 0, zero: 0, price: Number(a.primaryService.price) };
    row.visits += 1;
    row.revenue += Number(a.revenue);
    if (Number(a.revenue) === 0) row.zero += 1;
    byService.set(key, row);
  }

  console.log(`\n═══ ПО УСЛУГАМ (средний чек против цены в справочнике) ═══`);
  console.log(
    `  ${"услуга".padEnd(32)} ${"визитов".padStart(8)} ${"с нулём".padStart(8)} ` +
      `${"средний".padStart(10)} ${"в прайсе".padStart(10)}`,
  );
  for (const [title, row] of [...byService].sort((a, b) => b[1].visits - a[1].visits)) {
    const avg = row.visits ? row.revenue / row.visits : 0;
    // Расхождение больше пятой части — повод посмотреть: скидка, абонемент или
    // цена в справочнике устарела.
    const off = row.price > 0 && Math.abs(avg - row.price) > row.price * 0.2;
    console.log(
      `  ${title.slice(0, 31).padEnd(32)} ${String(row.visits).padStart(8)} ` +
        `${String(row.zero).padStart(8)} ${money(avg).padStart(10)} ${money(row.price).padStart(10)}` +
        (off ? "  ← расходится" : ""),
    );
  }
  if (noService > 0) {
    console.log(`\n  визитов без основной услуги: ${noService} — в разрез по услугам они не попадают`);
  }

  // ── Нулевые визиты: главный источник заниженной выручки
  const zeroAppts = appts.filter((a) => Number(a.revenue) === 0);
  console.log(`\n═══ ВИЗИТЫ С НУЛЕВОЙ ВЫРУЧКОЙ: ${zeroAppts.length} из ${appts.length} ═══`);
  if (zeroAppts.length > 0) {
    const byZeroService = new Map<string, number>();
    for (const a of zeroAppts) {
      const key = a.primaryService?.title ?? "(без услуги)";
      byZeroService.set(key, (byZeroService.get(key) ?? 0) + 1);
    }
    for (const [title, count] of [...byZeroService].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`  ${title.slice(0, 40).padEnd(42)} ${count}`);
    }
    const inCourse = zeroAppts.filter((a) => a.courseId).length;
    console.log(
      `\n  из них помечены как сеанс курса: ${inCourse}. Остальные ${zeroAppts.length - inCourse} — ` +
        `визиты, у которых в записи YCLIENTS не проставлена стоимость услуги.`,
    );
    console.log(
      `  Это и есть занижение: такой визит виден в «пришли», но в выручке даёт ноль.`,
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("не удалось:", e);
  await prisma.$disconnect();
  process.exit(1);
});
