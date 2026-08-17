"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import type { Appt } from "@/app/_data/store";
import { hypotheses, staffPerformance } from "@/lib/staff-analytics";
import { periodBounds, roomOccupancyBetween } from "@/lib/server/analytics";

/**
 * Серверный отчёт владельца — из БД (проекция Appointment + пациенты). Не мок:
 * данные персистентны, считаются на сервере. Когда подключим YCLIENTS (Этап 1),
 * та же проекция будет наполняться синком, а этот код не изменится.
 */
export interface OwnerStaffRow {
  name: string;
  appts: number;
  arrived: number;
  noShow: number;
  hours: number;
  revenue: number;
}
export interface OwnerRoomRow {
  name: string;
  ratePct: number;
}
export interface OwnerServiceRow {
  service: string;
  count: number;
  revenue: number;
}
export interface OwnerReport {
  revenue: number;
  appts: number;
  arrived: number;
  avgLoadPct: number;
  avgCheck: number;
  noShowRatePct: number;
  firstVisits: number;
  patients: { total: number; primary: number; noConsent: number };
  staff: OwnerStaffRow[];
  rooms: OwnerRoomRow[];
  services: OwnerServiceRow[];
  funnel: { dialogs: number; calls: number };
  hypotheses: string[];
}

const STATUS_MAP: Record<string, Appt["status"]> = {
  ARRIVED: "arrived",
  NO_SHOW: "no_show",
  CONFIRMED: "confirmed",
  CREATED: "planned",
};

/** Минута дня в таймзоне клиники по timestamptz. */
function minuteOfDay(at: Date, tz = "Europe/Moscow"): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

/**
 * Период кабинета владельца — последние тридцать дней, а не сегодня.
 *
 * Раздел называется «полный отчёт по клинике», но считал он один текущий день.
 * Отсюда «Неявки 0%» при ста двадцати двух неявках в базе: сегодня никто не
 * пропустил приём — и показатель честно показывал ноль, только отвечал он на
 * другой вопрос. Владельцу нужен месяц, операционная картина дня — на экране
 * «Сегодня».
 */
/**
 * Границы берём у отчётов, а не считаем свои.
 *
 * Свой расчёт отличался одной мелочью: он заканчивал период текущей минутой, а
 * отчёты — концом сегодняшнего дня. На загрузке процедурного кабинета это дало
 * 7% против 6% — знаменатель разный на остаток дня. Мелочь, но владелец видит
 * два числа под одинаковой подписью «за 30 дней», и объяснить это невозможно.
 *
 * Теперь период кабинета владельца — ровно тот же «Месяц», что и в отчётах.
 */
function ownerPeriod(): { start: Date; end: Date } {
  const { from, to } = periodBounds("month");
  return { start: from, end: to };
}

async function loadAppts(companyId: string): Promise<Appt[]> {
  const { start, end } = ownerPeriod();
  const rows = await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      status: { not: "CANCELLED" },
      startAt: { gte: start, lt: end },
    },
    include: {
      staff: { select: { name: true } },
      room: { select: { name: true, sortOrder: true } },
      primaryService: { select: { title: true } },
      patient: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    /**
     * Кабинет — по порядковому номеру, как во всём остальном интерфейсе, и
     * без подстановки первого. Здесь ключ выводился из названия («Кабинет 1…»),
     * а визит без кабинета приписывался первому: любой кабинет с другим
     * названием уезжал в третий, а тысяча визитов без привязки — в первый.
     */
    roomId: r.room ? `room-${r.room.sortOrder}` : null,
    roomName: r.room?.name ?? "",
    doctor: r.staff.name,
    service: r.primaryService?.title ?? "",
    patientId: r.patientId,
    patientName: r.patient?.name ?? "",
    startMinute: minuteOfDay(r.startAt),
    durationMin: r.durationMin,
    status: STATUS_MAP[r.status] ?? "planned",
    isFirstVisit: r.isFirstVisit,
    price: Number(r.revenue),
    note: r.note,
  }));
}

/**
 * Пациенты за тот же период, что и весь отчёт.
 *
 * Здесь считались новые «с полуночи», причём по часам сервера, а не клиники.
 * В отчёте, подписанном «за последние 30 дней», стояло дневное число — и оно
 * же уходило ИИ-аналитику владельца. Один экран должен отвечать про один
 * период.
 */
async function patientCounts(companyId: string) {
  const { start } = ownerPeriod();
  const [total, primary, noConsent] = await Promise.all([
    prisma.patient.count({ where: { companyId, deletedAt: null } }),
    prisma.patient.count({
      where: {
        companyId,
        deletedAt: null,
        // Карточки, перенесённые из YCLIENTS без визитов, новыми не считаются:
        // дату первого обращения у них взять было неоткуда (§8).
        firstSeenExact: true,
        firstSeenAt: { gte: start },
      },
    }),
    prisma.patient.count({
      where: { companyId, deletedAt: null, notes: { some: { kind: "NO_CONSENT", resolvedAt: null } } },
    }),
  ]);
  return { total, primary, noConsent };
}

function serviceBreakdown(appts: Appt[]): OwnerServiceRow[] {
  const map = new Map<string, OwnerServiceRow>();
  for (const a of appts) {
    const key = a.service || "—";
    const cur = map.get(key) ?? { service: key, count: 0, revenue: 0 };
    cur.count += 1;
    // Цена визита — из данных, а не из зашитого прайса по ключевым словам:
    // тот показывал остеопатию по 6500 при настоящих 8000.
    if (a.status === "arrived") cur.revenue += a.price ?? 0;
    map.set(key, cur);
  }
  return [...map.values()].sort((x, y) => y.revenue - x.revenue);
}

export async function getOwnerReport(): Promise<OwnerReport> {
  const session = await getSession();
  // Отчёт по выручке — только тем, кому это право выдано (§9).
  await requirePermission(session, "VIEW_REVENUE");
  const [appts, patients, dialogs, calls] = await Promise.all([
    loadAppts(session.companyId),
    patientCounts(session.companyId),
    prisma.conversation.count({ where: { companyId: session.companyId } }),
    prisma.callLog.count({ where: { companyId: session.companyId } }),
  ]);

  const perf = staffPerformance(appts);
  /**
   * Загрузка кабинетов — той же функцией, что и в отчётах.
   *
   * Здесь считалось своё: по зашитому списку «Кабинет 1/2/3», по зашитому дню
   * 9:00–21:00, и визит без кабинета приписывался первому. На экране владельца
   * выходило 8% там, где в отчётах 0%, — и понять, какому числу верить, было
   * невозможно. Правильный ответ: никакому, расхождение само по себе ошибка.
   */
  const { start, end } = ownerPeriod();
  const loads = await roomOccupancyBetween(session.companyId, start, end);
  const revenueSum = perf.reduce((s, p) => s + p.revenue, 0);
  const arrived = appts.filter((a) => a.status === "arrived").length;
  const noShow = appts.filter((a) => a.status === "no_show").length;
  const avgLoadPct = loads.length
    ? Math.round((loads.reduce((s, l) => s + l.rate, 0) / loads.length) * 100)
    : 0;

  return {
    revenue: revenueSum,
    appts: appts.length,
    arrived,
    avgLoadPct,
    avgCheck: arrived > 0 ? Math.round(revenueSum / arrived) : 0,
    noShowRatePct: appts.length > 0 ? Math.round((noShow / appts.length) * 100) : 0,
    firstVisits: appts.filter((a) => a.isFirstVisit).length,
    patients,
    staff: perf.map((p) => ({
      name: p.name,
      appts: p.appts,
      arrived: p.arrived,
      noShow: p.noShow,
      hours: p.bookedMinutes / 60,
      revenue: p.revenue,
    })),
    rooms: loads.map((l) => ({ name: l.name, ratePct: Math.round(l.rate * 100) })),
    services: serviceBreakdown(appts),
    funnel: { dialogs, calls },
    hypotheses: hypotheses(appts, loads),
  };
}

export interface WeekPoint {
  label: string;
  revenue: number;
  clients: number;
  appts: number;
}
export interface WeeklyDynamics {
  weeks: WeekPoint[];
  revenueGrowthPct: number | null;
  clientsGrowthPct: number | null;
}

function weekKey(d: Date): number {
  // Сдвигаем к московскому «настенному» времени и берём понедельник недели.
  const msk = new Date(d.getTime() + 3 * 3600 * 1000);
  const dow = (msk.getUTCDay() + 6) % 7; // 0 = понедельник
  return Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() - dow);
}
/**
 * Подпись недели — диапазоном, а не одной датой.
 *
 * Столбец «10.08» читался как «неделя с десятого», и владелец сравнивал его с
 * отчётом за «Неделю», который считает последние семь дней до сегодня. На
 * семнадцатое августа это 10–16 против 10–17: разные окна, разная выручка —
 * 205 тысяч против 215. Обе цифры верные, вопрос был в том, что подписи не
 * говорили, за какой отрезок они посчитаны.
 */
function weekLabel(key: number): string {
  const from = new Date(key);
  const to = new Date(key + 6 * 24 * 3600 * 1000);
  const dd = (d: Date) => String(d.getUTCDate()).padStart(2, "0");
  const mm = (d: Date) => String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd(from)}–${dd(to)}.${mm(to)}`;
}

/** Динамика по неделям (доход, клиенты, приёмы) за последние 6 недель. */
export async function getWeeklyDynamics(): Promise<WeeklyDynamics> {
  const session = await getSession();
  // Отчёт по выручке — только тем, кому это право выдано (§9).
  await requirePermission(session, "VIEW_REVENUE");
  const since = new Date(Date.now() - 8 * 7 * 24 * 3600 * 1000);
  const rows = await prisma.appointment.findMany({
    // Верхняя граница обязательна: без неё в динамику попадали будущие недели.
    where: { companyId: session.companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: since, lt: new Date() } },
    select: { startAt: true, revenue: true, patientId: true },
  });

  const buckets = new Map<number, { revenue: number; clients: Set<string>; appts: number }>();
  for (const r of rows) {
    const key = weekKey(r.startAt);
    const b = buckets.get(key) ?? { revenue: 0, clients: new Set<string>(), appts: 0 };
    b.revenue += Number(r.revenue);
    if (r.patientId) b.clients.add(r.patientId);
    b.appts += 1;
    buckets.set(key, b);
  }

  // Текущая неделя ещё не завершена — в динамику берём только полные недели.
  const currentWeek = weekKey(new Date());
  const keys = [...buckets.keys()].filter((k) => k < currentWeek).sort((a, b) => a - b).slice(-6);
  const weeks: WeekPoint[] = keys.map((k) => {
    const b = buckets.get(k)!;
    return { label: weekLabel(k), revenue: b.revenue, clients: b.clients.size, appts: b.appts };
  });

  const pct = (arr: number[]) => {
    if (arr.length < 2 || arr[0] === 0) return null;
    return Math.round(((arr[arr.length - 1] - arr[0]) / arr[0]) * 100);
  };
  return {
    weeks,
    revenueGrowthPct: pct(weeks.map((w) => w.revenue)),
    clientsGrowthPct: pct(weeks.map((w) => w.clients)),
  };
}

/** Текстовый срез базы для ИИ-аналитика владельца (только чтение). */
export async function getOwnerAiContext(): Promise<string> {
  const session = await getSession();
  // Отчёт по выручке — только тем, кому это право выдано (§9).
  await requirePermission(session, "VIEW_REVENUE");
  const [report, appts] = await Promise.all([getOwnerReport(), loadAppts(session.companyId)]);
  const lines: string[] = [];
  lines.push("# Сводка клиники");
  /**
   * Период — в каждом заголовке.
   *
   * Числа здесь месячные, а подписи говорили «сегодня»: аналитик на вопрос
   * «сколько было приёмов сегодня» уверенно называл цифру за тридцать дней.
   * Ошибиться так владелец мог только один раз — и в разговоре с клиентом.
   */
  const { start: pStart, end: pEnd } = ownerPeriod();
  const dayLabel = (d: Date) =>
    new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long" }).format(d);
  lines.push(
    `Период отчёта: ${dayLabel(pStart)} — ${dayLabel(new Date(pEnd.getTime() - 1))}. ` +
      "Все числа ниже — за этот период, а не за сегодня.",
  );
  lines.push(
    `Пациентов в базе всего: ${report.patients.total} (новых за период: ${report.patients.primary}, ` +
      `без согласия: ${report.patients.noConsent}).`,
  );
  lines.push(
    `Приёмов за период: ${report.appts} (пришли ${report.arrived}, первичных ${report.firstVisits}, ` +
      `неявки ${report.noShowRatePct}%). Выручка: ${report.revenue} ₽, средний чек ${report.avgCheck} ₽. ` +
      `Средняя загрузка кабинетов: ${report.avgLoadPct}%.`,
  );
  lines.push(`Воронка: диалогов ${report.funnel.dialogs}, звонков ${report.funnel.calls}.`);
  lines.push("");
  lines.push("# Выручка по услугам за период");
  // Верхние позиции: полный перечень раздувает запрос, а решения принимают
  // по значимым строкам.
  for (const s of report.services.slice(0, 8)) lines.push(`- ${s.service}: ${s.count} приёмов, ${s.revenue} ₽`);
  lines.push("");
  lines.push("# Сотрудники за период");
  for (const s of report.staff.slice(0, 10)) {
    lines.push(
      `- ${s.name}: приёмов ${s.appts} (пришли ${s.arrived}, неявок ${s.noShow}); ` +
        `часы ${s.hours.toFixed(1)}; выручка ${s.revenue} ₽.`,
    );
  }
  lines.push("");
  lines.push("# Загрузка кабинетов за период");
  for (const r of report.rooms) lines.push(`- ${r.name}: ${r.ratePct}%.`);
  const notes = appts.filter((a) => a.note && a.note.trim());
  if (notes.length) {
    lines.push("");
    lines.push("# Заметки администратора по визитам (отзывы, проблемы, пожелания)");
    for (const a of notes.slice(0, 15)) lines.push(`- ${a.service} у «${a.doctor}»: «${a.note?.slice(0, 200)}»`);
  }
  lines.push("");
  lines.push("# Уже замеченные гипотезы");
  for (const h of report.hypotheses) lines.push(`- ${h}`);
  return lines.join("\n");
}
