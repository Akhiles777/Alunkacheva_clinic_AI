import { prisma } from "@/lib/db";
import { startOfClinicDay } from "@/lib/clinic-time";
import { getDashboardMetricsDb } from "@/lib/server/analytics";

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
 *
 * Периоды считаются той же функцией, что и раздел «Отчёты». Это не экономия
 * кода, а требование: аналитик и отчёты обязаны показывать одно и то же. Стоит
 * посчитать здесь по-своему — и владелец получит две разные правды, а поверит
 * той, что удобнее.
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
  // Сутки клиники, а не сервера: иначе «новых пациентов сегодня» ночью врёт.
  const startOfToday = startOfClinicDay(now);

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
    prisma.patient.count({
      where: { companyId, deletedAt: null, firstSeenExact: true, firstSeenAt: { gte: startOfToday } },
    }),
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

  /**
   * Разрезы по периодам — теми же расчётами, что и в «Отчётах».
   *
   * Без них аналитик отвечал «точной цифры обращений за месяц нет»: он видел
   * только итоги за всё время и число «обратились сегодня». Владелец при этом
   * читал в приветствии, что аналитик видит воронку и загрузку кабинетов —
   * обещание, которого никто не выполнял.
   */
  for (const period of ["week", "month", "quarter"] as const) {
    const m = await getDashboardMetricsDb(companyId, period).catch(() => null);
    if (!m) continue;

    lines.push("");
    lines.push(`# ${m.period.label} (${m.period.from.slice(0, 10)} — ${m.period.to.slice(0, 10)}, рабочих дней ${m.period.workingDays})`);
    lines.push(
      `Воронка: обращений ${m.funnel.inquiries}, записались ${m.funnel.booked}, пришли ${m.funnel.arrived}. ` +
        (m.fromDialog ? `Из переписки с агентом: записались ${m.fromDialog.booked}, пришли ${m.fromDialog.arrived}.` : ""),
    );
    lines.push(
      `Выручка ${money(m.money.revenue)}; средний чек ${money(m.money.avgCheck)}; ` +
        `новых пациентов ${m.money.newPatients}.`,
    );
    lines.push(`Записалось за период по дате записи: ${m.bookedInPeriod}.`);
    lines.push(
      `Состоявшиеся визиты: первичных ${m.visitMix.first}, курсовых ${m.visitMix.courseSession}, ` +
        `повторных ${m.visitMix.returned}, всего ${m.visitMix.total}.`,
    );

    const sources = m.sources.filter((s) => s.inquiries > 0 || s.booked > 0);
    if (sources.length) {
      lines.push(
        "Обращения по источникам: " +
          sources.map((s) => `${s.title} — ${s.inquiries} обращений, ${s.booked} записей`).join("; "),
      );
    }

    const staff = m.staff.filter((s) => s.appointments > 0);
    if (staff.length) {
      lines.push(
        "Специалисты: " +
          staff.map((s) => `${s.name} — ${s.appointments} приёмов, ${money(s.revenue)}`).join("; "),
      );
    }

    if (m.rooms.length) {
      lines.push(
        "Загрузка кабинетов за период: " +
          m.rooms.map((r) => `${r.roomName} — ${Math.round(r.periodOccupancy * 100)}%`).join("; "),
      );
    }
  }

  /**
   * Помесячная динамика: без неё на вопрос «как изменилось» аналитик отвечал
   * общими словами. Считаем прямо в базе — двенадцать месяцев одним запросом.
   */
  const byMonth = await prisma.$queryRaw<{ month: Date; visits: bigint; revenue: number | null }[]>`
    SELECT date_trunc('month', "startAt") AS month,
           COUNT(*)                       AS visits,
           SUM(revenue)::float            AS revenue
      FROM appointments
     WHERE "companyId" = ${companyId}
       AND "deletedAt" IS NULL
       AND status = 'ARRIVED'
       AND "startAt" >= ${new Date(now.getFullYear() - 1, now.getMonth(), 1)}
     GROUP BY 1
     ORDER BY 1
  `;
  if (byMonth.length) {
    lines.push("");
    lines.push("# По месяцам (состоявшиеся визиты и выручка)");
    for (const row of byMonth) {
      lines.push(
        `- ${row.month.toISOString().slice(0, 7)}: ${Number(row.visits)} визитов, ${money(Number(row.revenue ?? 0))}`,
      );
    }
  }

  /**
   * Удержание. Владельца интересует не «сколько пришло», а «сколько
   * вернулось»: на этом строится вся экономика клиники, где курс лечения —
   * три-пять приёмов.
   */
  const [returning, once] = await Promise.all([
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM (
        SELECT "patientId" FROM appointments
         WHERE "companyId" = ${companyId} AND "deletedAt" IS NULL AND status = 'ARRIVED'
         GROUP BY "patientId" HAVING COUNT(*) > 1
      ) t
    `,
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM (
        SELECT "patientId" FROM appointments
         WHERE "companyId" = ${companyId} AND "deletedAt" IS NULL AND status = 'ARRIVED'
         GROUP BY "patientId" HAVING COUNT(*) = 1
      ) t
    `,
  ]);
  const repeat = Number(returning[0]?.count ?? 0);
  const single = Number(once[0]?.count ?? 0);
  if (repeat + single > 0) {
    lines.push("");
    lines.push(
      `# Удержание\nВернулись хотя бы раз: ${repeat} из ${repeat + single} пациентов с визитами ` +
        `(${Math.round((repeat / (repeat + single)) * 100)}%).`,
    );
  }

  /** Отмены и неявки: прямые потери, о которых спрашивают в первую очередь. */
  const [cancelled, noShow] = await Promise.all([
    prisma.appointment.count({ where: { companyId, deletedAt: null, status: "CANCELLED" } }),
    prisma.appointment.count({ where: { companyId, deletedAt: null, status: "NO_SHOW" } }),
  ]);
  lines.push("");
  lines.push(`# Потери\nОтменённых записей: ${cancelled}; неявок: ${noShow}.`);

  return lines.join("\n");
}
