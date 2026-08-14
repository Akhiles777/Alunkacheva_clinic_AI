import { prisma } from "@/lib/db";

/**
 * Снимок клиники для ИИ-аналитика — из базы.
 *
 * Прежде выжимка собиралась в браузере, по стору. А стор наполняется тем, что
 * нужно экрану: расписанием на сегодня и списком пациентов без визитов.
 * Поэтому аналитик владельца отвечал только про сегодняшний день и не знал ни
 * истории визитов, ни выручки, ни услуг — не потому, что плохо думал, а
 * потому что этих данных ему не давали.
 *
 * Здесь — агрегаты по всей базе. Персональные данные не уходят: ни ФИО, ни
 * телефонов, ни диагнозов (§7). Только числа и названия услуг.
 */

const DAY = 24 * 3600 * 1000;

function money(v: number): string {
  return `${Math.round(v).toLocaleString("ru-RU")} ₽`;
}

export async function buildClinicSnapshot(companyId: string, now = new Date()): Promise<string> {
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthAgo = new Date(now.getTime() - 30 * DAY);
  const quarterAgo = new Date(now.getTime() - 90 * DAY);
  const yearAgo = new Date(now.getTime() - 365 * DAY);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const [
    patients,
    withVisits,
    newToday,
    appts,
    arrived,
    arrivedMonth,
    arrivedQuarter,
    plannedAhead,
    revenueYear,
    revenueMonth,
    firstVisits,
    dialogs,
    openEscalations,
    topServices,
    topStaff,
    sources,
    gaps,
  ] = await Promise.all([
    prisma.patient.count({ where: { companyId, deletedAt: null } }),
    prisma.patient.count({ where: { companyId, deletedAt: null, appointments: { some: { deletedAt: null } } } }),
    prisma.patient.count({ where: { companyId, deletedAt: null, firstSeenAt: { gte: startOfToday } } }),
    prisma.appointment.count({ where: { companyId, deletedAt: null } }),
    prisma.appointment.count({ where: { companyId, deletedAt: null, status: "ARRIVED" } }),
    prisma.appointment.count({
      where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: monthAgo } },
    }),
    prisma.appointment.count({
      where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: quarterAgo } },
    }),
    prisma.appointment.count({
      where: { companyId, deletedAt: null, status: { notIn: ["CANCELLED"] }, startAt: { gte: now } },
    }),
    prisma.appointment.aggregate({
      where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: yearAgo } },
      _sum: { revenue: true },
    }),
    prisma.appointment.aggregate({
      where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: startOfMonth } },
      _sum: { revenue: true },
    }),
    prisma.appointment.count({ where: { companyId, deletedAt: null, isFirstVisit: true } }),
    prisma.conversation.count({ where: { companyId } }),
    prisma.escalation.count({ where: { companyId, status: { not: "RESOLVED" } } }),
    prisma.appointment.groupBy({
      by: ["primaryServiceId"],
      where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: quarterAgo } },
      _count: { _all: true },
      _sum: { revenue: true },
    }),
    prisma.appointment.groupBy({
      by: ["staffId"],
      where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: quarterAgo } },
      _count: { _all: true },
      _sum: { revenue: true },
    }),
    prisma.patient.groupBy({
      by: ["sourceId"],
      where: { companyId, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.$queryRaw<{ avg: number | null }[]>`
      SELECT AVG(EXTRACT(EPOCH FROM diff) / 86400)::float AS avg
        FROM (
          SELECT "startAt" - LAG("startAt") OVER (PARTITION BY "patientId" ORDER BY "startAt") AS diff
            FROM appointments
           WHERE "companyId" = ${companyId} AND "deletedAt" IS NULL AND status = 'ARRIVED'
        ) g
       WHERE diff IS NOT NULL
    `,
  ]);

  const [serviceTitles, staffNames, sourceTitles] = await Promise.all([
    prisma.service.findMany({ where: { companyId }, select: { id: true, title: true } }),
    prisma.staff.findMany({ where: { companyId }, select: { id: true, name: true, specialty: true } }),
    prisma.source.findMany({ where: { companyId }, select: { id: true, title: true } }),
  ]);
  const serviceById = new Map(serviceTitles.map((s) => [s.id, s.title]));
  const staffById = new Map(staffNames.map((s) => [s.id, s]));
  const sourceById = new Map(sourceTitles.map((s) => [s.id, s.title]));

  const lines: string[] = [];
  lines.push("# База клиники (все данные, не только сегодня)");
  lines.push(
    `Пациентов всего: ${patients}; с визитами: ${withVisits}; обратились сегодня: ${newToday}.`,
  );
  const avg = gaps[0]?.avg;
  if (typeof avg === "number" && Number.isFinite(avg)) {
    lines.push(`Средний интервал между визитами: ${Math.round(avg)} дней.`);
  }

  lines.push("");
  lines.push("# Визиты");
  lines.push(
    `Всего в базе: ${appts}; состоялись: ${arrived}; из них первичных: ${firstVisits}. ` +
      `За 30 дней состоялось: ${arrivedMonth}; за 90 дней: ${arrivedQuarter}. ` +
      `Запланировано вперёд: ${plannedAhead}.`,
  );
  lines.push(
    `Выручка за 12 месяцев: ${money(Number(revenueYear._sum.revenue ?? 0))}; ` +
      `с начала текущего месяца: ${money(Number(revenueMonth._sum.revenue ?? 0))}.`,
  );

  lines.push("");
  lines.push("# Услуги за 90 дней (по числу состоявшихся визитов)");
  for (const row of topServices
    .filter((r) => r.primaryServiceId)
    .sort((a, b) => b._count._all - a._count._all)
    .slice(0, 15)) {
    const title = serviceById.get(row.primaryServiceId!) ?? "без услуги";
    lines.push(`- ${title}: ${row._count._all} визитов, ${money(Number(row._sum.revenue ?? 0))}`);
  }

  lines.push("");
  lines.push("# Специалисты за 90 дней");
  for (const row of topStaff.sort((a, b) => b._count._all - a._count._all).slice(0, 15)) {
    const s = staffById.get(row.staffId);
    lines.push(
      `- ${s?.name ?? "—"}${s?.specialty ? ` (${s.specialty})` : ""}: ` +
        `${row._count._all} визитов, ${money(Number(row._sum.revenue ?? 0))}`,
    );
  }

  lines.push("");
  lines.push("# Источники пациентов");
  for (const row of sources.sort((a, b) => b._count._all - a._count._all)) {
    const title = row.sourceId ? (sourceById.get(row.sourceId) ?? "—") : "из выгрузки YCLIENTS";
    lines.push(`- ${title}: ${row._count._all}`);
  }

  lines.push("");
  lines.push(`# Переписка\nДиалогов: ${dialogs}; открытых эскалаций: ${openEscalations}.`);

  return lines.join("\n");
}
