/**
 * Сверка посещаемости и выручки: неявки, разобранность, разрезы по людям и
 * по услугам, дубли справочника.
 *
 * Отвечает на два вопроса, которые нельзя решить по экрану:
 *
 *   1. можно ли верить неявкам — то есть сколько прошедших приёмов вообще не
 *      отмечены. «Неявки 0%» означает либо «неявок нет», либо «никто ничего
 *      не отмечает», и различить их можно только числом;
 *   2. сходятся ли деньги — выручка по услугам, по специалистам и итог должны
 *      давать одну и ту же сумму. Расхождение само по себе дефект: владелец
 *      поверит удобному числу.
 *
 *   npx tsx scripts/attendance-check.ts            # 90 дней
 *   npx tsx scripts/attendance-check.ts 365
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { attendanceAudit } from "../lib/metrics/attendance";
import { classifyIdleServices, normalizeServiceTitle } from "../lib/metrics/service-load";

const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

async function main() {
  const days = Number(process.argv[2] ?? 90);
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 3600 * 1000);

  console.log(`клиника: ${company.name}`);
  console.log(`период: ${from.toISOString().slice(0, 10)} — ${to.toISOString().slice(0, 10)} (${days} дн.)\n`);

  const appts = await prisma.appointment.findMany({
    where: { companyId: company.id, deletedAt: null, startAt: { gte: from, lt: to } },
    select: {
      id: true,
      startAt: true,
      status: true,
      revenue: true,
      staff: { select: { name: true } },
      primaryService: { select: { title: true } },
      services: { select: { priceCharged: true, service: { select: { title: true } } } },
    },
    orderBy: { startAt: "asc" },
  });

  // ── 1. разобранность
  const audit = attendanceAudit(
    appts.map((a) => ({ startAt: a.startAt, status: a.status, revenue: Number(a.revenue) })),
  );
  console.log("── ПОСЕЩАЕМОСТЬ");
  console.log(`  всего записей:        ${appts.length}`);
  console.log(`  пришли:               ${audit.arrived}`);
  console.log(`  не пришли:            ${audit.noShow}`);
  console.log(`  отменены:             ${audit.cancelled}`);
  console.log(`  впереди:              ${audit.upcoming}`);
  console.log(`  БЕЗ ОТМЕТКИ ИСХОДА:   ${audit.unmarked} на ${money(audit.unmarkedMoney)}`);
  console.log(`  доля неявок:          ${pct(audit.noShowRate)} (только по отмеченным)`);
  console.log(`  разобрано:            ${pct(audit.coverage)}`);
  if (audit.oldestUnmarkedAt) {
    console.log(`  самый старый без отметки: ${audit.oldestUnmarkedAt.toISOString().slice(0, 10)}`);
  }
  if (audit.unmarked > 0) {
    console.log(
      `\n  Пока эти ${audit.unmarked} приёмов не отмечены, «Пришли», «Неявки», «Первичные»\n` +
        `  и выручка показывают меньше, чем было. Отмечаются они в YCLIENTS.`,
    );
  }

  // ── 2. выручка: три разреза одного периода
  const arrived = appts.filter((a) => a.status === "ARRIVED");
  const total = arrived.reduce((s, a) => s + Number(a.revenue), 0);

  const byStaff = new Map<string, { count: number; revenue: number }>();
  for (const a of arrived) {
    const key = a.staff?.name ?? "специалист не указан";
    const acc = byStaff.get(key) ?? { count: 0, revenue: 0 };
    acc.count += 1;
    acc.revenue += Number(a.revenue);
    byStaff.set(key, acc);
  }

  const byService = new Map<string, { count: number; revenue: number }>();
  let compositionSum = 0;
  let withoutComposition = 0;
  for (const a of arrived) {
    if (a.services.length > 0) {
      for (const p of a.services) {
        const acc = byService.get(p.service.title) ?? { count: 0, revenue: 0 };
        acc.count += 1;
        acc.revenue += Number(p.priceCharged);
        byService.set(p.service.title, acc);
        compositionSum += Number(p.priceCharged);
      }
    } else {
      withoutComposition += 1;
      const key = a.primaryService?.title ?? "услуга не указана";
      const acc = byService.get(key) ?? { count: 0, revenue: 0 };
      acc.count += 1;
      acc.revenue += Number(a.revenue);
      byService.set(key, acc);
      compositionSum += Number(a.revenue);
    }
  }

  const staffSum = [...byStaff.values()].reduce((s, v) => s + v.revenue, 0);
  console.log("\n── ВЫРУЧКА ПРИЁМОВ (без проданных курсов)");
  console.log(`  итог по визитам:      ${money(total)}`);
  console.log(`  сумма по специалистам:${money(staffSum)}`);
  console.log(`  сумма по услугам:     ${money(compositionSum)}`);
  const drift = Math.abs(total - compositionSum);
  console.log(
    drift < 1
      ? "  ✓ разрезы сходятся"
      : `  ✗ РАСХОЖДЕНИЕ по услугам: ${money(drift)} — состав визита не сходится с его суммой`,
  );
  if (withoutComposition > 0) {
    console.log(`  визитов без состава:  ${withoutComposition} (учтены по основной услуге)`);
  }

  console.log("\n  по специалистам:");
  for (const [name, v] of [...byStaff].sort((a, b) => b[1].revenue - a[1].revenue)) {
    console.log(`    ${name.padEnd(28)} ${String(v.count).padStart(4)} приёмов  ${money(v.revenue).padStart(14)}`);
  }

  // ── 3. дубли справочника
  const services = await prisma.service.findMany({
    where: { companyId: company.id },
    select: { id: true, title: true, price: true, isActive: true },
  });
  const apptCount = new Map<string, number>();
  for (const a of appts) {
    for (const p of a.services) apptCount.set(p.service.title, (apptCount.get(p.service.title) ?? 0) + 1);
    if (a.services.length === 0 && a.primaryService) {
      apptCount.set(a.primaryService.title, (apptCount.get(a.primaryService.title) ?? 0) + 1);
    }
  }

  const idle = classifyIdleServices(
    services.map((s) => ({
      title: s.title,
      appointments: apptCount.get(s.title) ?? 0,
      price: Number(s.price),
    })),
  );

  console.log("\n── СПРАВОЧНИК УСЛУГ");
  console.log(`  всего строк:          ${services.length}`);
  for (const reason of ["DUPLICATE", "NOT_ORDERED", "NO_PRICE", "STAFF_ONLY"] as const) {
    const list = idle.filter((s) => s.reason === reason);
    if (list.length === 0) continue;
    const label = {
      DUPLICATE: "ДУБЛИ (приёмы на тёзке)",
      NOT_ORDERED: "не заказывали за период",
      NO_PRICE: "заготовки без цены",
      STAFF_ONLY: "служебные",
    }[reason];
    console.log(`  ${label}: ${list.length}`);
    for (const s of list) console.log(`    · ${s.title}`);
  }

  /**
   * Строки справочника с одинаковым названием — источник того самого «услуги
   * не видно, хотя приёмы идут». Называем поимённо с числом приёмов у каждой.
   */
  const byTitle = new Map<string, { title: string; id: string; appts: number; active: boolean }[]>();
  for (const s of services) {
    const key = normalizeServiceTitle(s.title);
    const row = { title: s.title, id: s.id, appts: apptCount.get(s.title) ?? 0, active: s.isActive };
    const list = byTitle.get(key);
    if (list) list.push(row);
    else byTitle.set(key, [row]);
  }
  const twins = [...byTitle.values()].filter((v) => v.length > 1);
  if (twins.length > 0) {
    console.log(`\n  ОДНО НАЗВАНИЕ — НЕСКОЛЬКО СТРОК: ${twins.length}`);
    for (const group of twins) {
      console.log(`    «${group[0].title}»`);
      for (const r of group) {
        console.log(`      ${r.id} · приёмов ${r.appts} · ${r.active ? "включена" : "выключена"}`);
      }
    }
    console.log("    Слить их можно в «Настройки → Услуги»; приёмы держатся за конкретную строку.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
