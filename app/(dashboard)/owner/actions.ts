"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import type { Appt } from "@/app/_data/store";
import { hypotheses, staffPerformance } from "@/lib/staff-analytics";
import { coursePurchasesBetween } from "@/lib/server/course-revenue";
import { revenueByService, type CourseSaleForRevenue } from "@/lib/metrics/service-revenue";
import { averageCheck, noShowRate } from "@/lib/metrics/summary";
import { periodBounds, roomOccupancyBetween } from "@/lib/server/analytics";
import { weekKeyOf } from "@/lib/metrics/types";
import { revenueByDay } from "@/lib/server/daily-revenue";

/**
 * Серверный отчёт владельца — из БД (проекция Appointment + пациенты). Не мок:
 * данные персистентны, считаются на сервере. Когда подключим YCLIENTS (Этап 1),
 * та же проекция будет наполняться синком, а этот код не изменится.
 */
export interface OwnerStaffRow {
  /** Записи, время которых ещё не прошло. */
  planned?: number;
  /** Ключ строки: по имени не различить тёзок. */
  staffId: string | null;
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
  /**
   * За какой отрезок посчитан весь экран.
   *
   * Подпись «за 30 дней» стояла только над загрузкой кабинетов: у таблицы
   * сотрудников и у выручки по услугам периода не было видно вовсе, и
   * владелец сравнивал их с отчётами за другой отрезок. Даты обязательны —
   * окно скользящее, и «30 дней» без границ проверить нечем.
   */
  period: { days: number; from: string; to: string };
  revenue: number;
  appts: number;
  arrived: number;
  avgLoadPct: number;
  avgCheck: number;
  /**
   * Курсы, которым специалиста не нашлось: они есть в итоге и в разрезе по
   * услугам, но не в таблице людей. Без этого числа сумма строк меньше итога.
   */
  coursesWithoutStaff: number;
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
/** Сколько дней показывает кабинет владельца. То же окно, что «Месяц» в отчётах. */
const OWNER_PERIOD_DAYS = 30;

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
      // Идентификатор обязателен: строки разреза собираются по нему, а не по
      // имени. Без него визиты попадали в строку с ключом-именем, а деньги за
      // курсы — в строку с ключом-идентификатором, и один специалист
      // показывался двумя строками: «0 приёмов, 228 000 ₽» и «63 приёма,
      // 5 800 ₽».
      staff: { select: { id: true, name: true } },
      room: { select: { name: true, sortOrder: true } },
      primaryService: { select: { title: true } },
      patient: { select: { name: true } },
      // Состав визита: разрез по услугам считается по нему (§8).
      services: { select: { priceCharged: true, service: { select: { title: true } } } },
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
    staffId: r.staff.id,
    service: r.primaryService?.title ?? "",
    parts: r.services.map((sv) => ({
      title: sv.service.title,
      amount: Number(sv.priceCharged),
    })),
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

/**
 * Разрез по услугам — общей функцией отчётов, а не своей.
 *
 * Здесь была третья реализация: по основной услуге визита и без продаж курсов.
 * «БОС-терапия, 41 приём, 0 ₽» — сеансы курса стоят нулём, а деньги за курсы
 * этот экран не видел вовсе. Своя арифметика на экране — источник двух правд,
 * и владелец поверит удобной (§8).
 */
function serviceBreakdown(appts: Appt[], sales: CourseSaleForRevenue[]): OwnerServiceRow[] {
  return revenueByService(
    appts.map((a) => ({
      status: a.status,
      doctor: a.doctor,
      price: a.price ?? 0,
      service: a.service,
      parts: a.parts ?? [],
    })),
    sales,
  ).map((r) => ({ service: r.name, count: r.count, revenue: r.revenue }));
}

export async function getOwnerReport(): Promise<OwnerReport> {
  const session = await getSession();
  // Отчёт по выручке — только тем, кому это право выдано (§9).
  await requirePermission(session, "VIEW_REVENUE");
  const period = ownerPeriod();
  /**
   * Воронка — за тот же период, что и всё остальное на экране.
   *
   * Здесь считались все диалоги и все звонки за всю историю клиники, и стояли
   * они рядом с выручкой за тридцать дней. Число выглядело измеренным, росло
   * всегда и ни с чем на экране не сходилось: сравнить «диалогов 812» с
   * «первичных 14» нельзя, это разные отрезки времени.
   *
   * Диалоги считаем по последнему сообщению, а не по дате начала переписки:
   * постоянный пациент пишет в тот же чат месяцами (§8), и «новых диалогов»
   * тут было бы почти ноль при живой переписке каждый день.
   */
  const [appts, patients, dialogs, calls] = await Promise.all([
    loadAppts(session.companyId),
    patientCounts(session.companyId),
    prisma.conversation.count({
      where: {
        companyId: session.companyId,
        deletedAt: null,
        lastMessageAt: { gte: period.start, lt: period.end },
      },
    }),
    prisma.callLog.count({
      where: { companyId: session.companyId, createdAt: { gte: period.start, lt: period.end } },
    }),
  ]);

  /**
   * Проданные курсы за тот же период.
   *
   * Их деньги — выручка дней покупки, и в разрезах они обязаны быть: иначе
   * специалист, ведущий курсы, выглядит бесполезным, а услуга — бесплатной.
   */
  const purchases = await coursePurchasesBetween(session.companyId, period.start, period.end);
  const sales: (CourseSaleForRevenue & { staffId: string | null })[] = purchases.map((p) => ({
    serviceTitle: p.serviceTitle,
    // Идентификатор — чтобы не склеивать тёзок; имя — чтобы показать строку.
    staffId: p.staffId,
    staffName: p.staffName,
    amount: p.amount,
  }));

  const perf = staffPerformance(appts, sales);
  /**
   * Загрузка кабинетов — той же функцией, что и в отчётах.
   *
   * Здесь считалось своё: по зашитому списку «Кабинет 1/2/3», по зашитому дню
   * 9:00–21:00, и визит без кабинета приписывался первому. На экране владельца
   * выходило 8% там, где в отчётах 0%, — и понять, какому числу верить, было
   * невозможно. Правильный ответ: никакому, расхождение само по себе ошибка.
   */
  const loads = await roomOccupancyBetween(session.companyId, period.start, period.end);
  /**
   * Итог — сумма по специалистам плюс курсы, которым специалиста не нашлось.
   *
   * Курс без сеансов в разрез по людям не идёт (приписывать некому), но деньги
   * клиника получила: без этой добавки итог был бы меньше суммы своих же
   * строк на экране ниже.
   */
  const orphanCourses = sales
    .filter((x) => !x.staffName)
    .reduce((sum, x) => sum + x.amount, 0);

  const revenueSum = perf.reduce((s, p) => s + p.revenue, 0) + orphanCourses;
  const arrivedRows = appts.filter((a) => a.status === "arrived");
  const arrived = arrivedRows.length;
  /** Приёмы, принёсшие деньги, — знаменатель чека вместе с продажами курсов. */
  const paidVisits = arrivedRows.filter((a) => (a.price ?? 0) > 0).length;
  const noShow = appts.filter((a) => a.status === "no_show").length;
  const avgLoadPct = loads.length
    ? Math.round((loads.reduce((s, l) => s + l.rate, 0) / loads.length) * 100)
    : 0;

  const dayLabel = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
  });

  return {
    period: {
      days: OWNER_PERIOD_DAYS,
      from: dayLabel.format(period.start),
      // Конец периода — исключающая граница (полночь следующего дня): в
      // подписи показываем последний день периода, а не первый день после него.
      to: dayLabel.format(new Date(period.end.getTime() - 1)),
    },
    revenue: revenueSum,
    appts: appts.length,
    arrived,
    avgLoadPct,
    /**
     * Средний чек — общей функцией: округление тоже часть определения.
     *
     * Знаменатель — оплаченные чеки: приёмы с суммой плюс проданные курсы.
     * Сеанс оплаченного курса денег в этот день не приносит, бесплатный приём
     * не приносит вовсе, и делить на них выручку значит занижать чек ровно за
     * то, что клиника продаёт курсы.
     */
    avgCheck: averageCheck(revenueSum, paidVisits + sales.length),
    /**
     * Неявки — той же функцией, что и в карточке специалиста.
     *
     * Здесь знаменателем были все незаменённые визиты, включая запланированные
     * на следующую неделю: они неявкой ещё быть не могли и только разбавляли
     * показатель. У специалиста то же самое считалось по состоявшимся исходам,
     * и два числа под подписью «Неявки» расходились вдвое.
     */
    noShowRatePct: noShowRate(arrived, noShow),
    /**
     * Первичные — первый визит пациента СО СТАТУСОМ «пришёл» (§8).
     *
     * Здесь считались все записи подряд, включая запланированные и неявки. В
     * отчётах то же слово означает состоявшиеся первичные, и числа расходились
     * тем сильнее, чем больше в периоде будущих записей.
     */
    firstVisits: appts.filter((a) => a.isFirstVisit && a.status === "arrived").length,
    patients,
    staff: perf.map((p) => ({
      staffId: p.staffId,
      name: p.name,
      appts: p.appts,
      planned: p.planned,
      arrived: p.arrived,
      noShow: p.noShow,
      hours: p.bookedMinutes / 60,
      revenue: p.revenue,
    })),
    coursesWithoutStaff: orphanCourses,
    rooms: loads.map((l) => ({ name: l.name, ratePct: Math.round(l.rate * 100) })),
    services: serviceBreakdown(appts, sales),
    funnel: { dialogs, calls },
    hypotheses: hypotheses(appts, loads),
  };
}

export interface WeekPoint {
  label: string;
  /**
   * Ключ периода отчёта — «w2026-08-10».
   *
   * По нему столбец открывает «Отчёты» ровно за свою неделю. Прежде сравнивать
   * было не с чем: график считал полные недели с понедельника, отчёт — последние
   * семь дней до сегодня, и под словом «неделя» стояли два разных числа.
   */
  key: string;
  revenue: number;
  clients: number;
  appts: number;
  /**
   * Оплаченные чеки недели — знаменатель среднего чека: приёмы с суммой плюс
   * проданные курсы. Сеансы курса и бесплатные приёмы не в счёт.
   */
  paying: number;
}
export interface WeeklyDynamics {
  weeks: WeekPoint[];
  revenueGrowthPct: number | null;
  clientsGrowthPct: number | null;
}

function weekStart(d: Date): number {
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

  const buckets = new Map<
    number,
    { revenue: number; clients: Set<string>; appts: number; paying: number }
  >();
  for (const r of rows) {
    const key = weekStart(r.startAt);
    const b = buckets.get(key) ?? { revenue: 0, clients: new Set<string>(), appts: 0, paying: 0 };
    b.revenue += Number(r.revenue);
    if (r.patientId) b.clients.add(r.patientId);
    b.appts += 1;
    if (Number(r.revenue) > 0) b.paying += 1;
    buckets.set(key, b);
  }

  /**
   * Проданные курсы — в ту же неделю, в которую куплены.
   *
   * Это была четвёртая по счёту реализация выручки в проекте, и единственная,
   * куда курсы не попали: график читал визиты напрямую и складывал их
   * стоимость. За неделю 10–16 августа он показывал 174 000 ₽, а отчёты за ту
   * же неделю — 240 455 ₽. Разница — деньги за курсы, проданные кассой.
   *
   * Приёмом продажа не считается и в число клиентов недели не идёт: приёмом
   * были её сеансы, они уже посчитаны выше.
   */
  for (const p of await coursePurchasesBetween(session.companyId, since, new Date())) {
    const key = weekStart(p.at);
    const b = buckets.get(key) ?? { revenue: 0, clients: new Set<string>(), appts: 0, paying: 0 };
    b.revenue += p.amount;
    // Приёмом продажа не считается, а чеком — да: у неё есть клиент и сумма.
    b.paying += 1;
    buckets.set(key, b);
  }

  // Текущая неделя ещё не завершена — в динамику берём только полные недели.
  const currentWeek = weekStart(new Date());
  const keys = [...buckets.keys()].filter((k) => k < currentWeek).sort((a, b) => a - b).slice(-6);
  const weeks: WeekPoint[] = keys.map((k) => {
    const b = buckets.get(k)!;
    return {
      label: weekLabel(k),
      key: weekKeyOf(new Date(k + 12 * 3600 * 1000)),
      revenue: b.revenue,
      clients: b.clients.size,
      appts: b.appts,
      paying: b.paying,
    };
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
    `Визитов за период: ${report.appts} — из них состоялись ${report.arrived} ` +
      `(первичных ${report.firstVisits}, ` +
      `неявки ${report.noShowRatePct}%). Выручка: ${report.revenue} ₽, средний чек ${report.avgCheck} ₽. ` +
      `Средняя загрузка кабинетов: ${report.avgLoadPct}%.`,
  );
  lines.push(`Воронка: диалогов ${report.funnel.dialogs}, звонков ${report.funnel.calls}.`);
  lines.push("");
  lines.push("# Выручка по услугам за период (считаются состоявшиеся приёмы)");
  // Верхние позиции: полный перечень раздувает запрос, а решения принимают
  // по значимым строкам.
  for (const s of report.services.slice(0, 8)) lines.push(`- ${s.service}: ${s.count} приёмов, ${s.revenue} ₽`);
  lines.push("");
  lines.push("# Сотрудники за период");
  for (const s of report.staff.slice(0, 10)) {
    lines.push(
      `- ${s.name}: пришли ${s.arrived}, неявок ${s.noShow}, впереди ${s.planned ?? 0}; ` +
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
  /**
   * Выручка по дням — до гипотез и до заметок.
   *
   * На «какая выручка была вчера» аналитик отвечал, что дневного среза в
   * сводке нет: ему давали только недельные и месячные итоги. Данные при этом
   * лежали в базе. Дни отмечены словами «вчера» и «сегодня», чтобы модель не
   * считала даты сама — на этом она ошибается чаще всего.
   */
  const daily = await revenueByDay(session.companyId, 30);
  const todayKey = daily[daily.length - 1]?.date;
  const yesterdayKey = daily[daily.length - 2]?.date;
  lines.push("");
  lines.push("# Выручка по дням (последние 30 дней)");
  for (const d of daily) {
    const mark = d.date === todayKey ? " — СЕГОДНЯ" : d.date === yesterdayKey ? " — ВЧЕРА" : "";
    lines.push(
      `- ${d.date} (${d.label})${mark}: выручка ${d.revenue} ₽, пришли ${d.arrived}` +
        // Первичные и повторные — в каждой строке: на «сколько сегодня
        // первичных» аналитик отвечать не мог, этого числа ему не давали.
        `${d.arrived > 0 ? `, первичных ${d.firstVisits}, повторных ${d.repeatVisits}` : ""}` +
        `${d.noShow > 0 ? `, неявок ${d.noShow}` : ""}` +
        `${d.avgCheck > 0 ? `, средний чек ${d.avgCheck} ₽` : ""}`,
    );
    /**
     * Из чего сложился день. Без этого на «а почему столько» аналитик снова
     * упирался бы в стену: сумма есть, состава нет.
     */
    if (d.byStaff.length > 0) {
      lines.push(
        `    по специалистам: ${d.byStaff.map((x) => `${x.name} — ${x.revenue} ₽ (${x.arrived})`).join("; ")}`,
      );
      lines.push(
        `    по услугам: ${d.byService.map((x) => `${x.name} — ${x.revenue} ₽ (${x.arrived})`).join("; ")}`,
      );
    }
  }

  lines.push("");
  lines.push("# Уже замеченные гипотезы");
  for (const h of report.hypotheses) lines.push(`- ${h}`);
  return lines.join("\n");
}
