import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  attendanceBetween,
  clinicWeekday,
  dayInterval,
  getDashboardMetricsDb,
  isoDate,
  loadSchedule,
  minuteOfDay,
  periodBounds,
  roomOccupancyBetween,
  workingMinutesBetween,
} from "@/lib/server/analytics";
import { closedDatesBetween } from "@/lib/server/clinic-day";
import { getCallbackQueue } from "@/lib/server/callback-queue";
import { calculate } from "@/lib/assistant/calc";

/**
 * Расчёты, которые аналитик владельца вызывает сам (function calling).
 *
 * Прежде аналитик получал одну готовую сводку и всё, чего в ней не было,
 * честно называл «нет данных»: «сколько мы потеряли на незаполненных
 * кабинетах?» — без ответа. Считать сам он не должен (§8) — значит, считать
 * должны мы, но по его запросу. Каждая функция здесь — расчёт по базе той же
 * логикой, что экраны; модель выбирает, что спросить, и связывает ответ
 * словами.
 *
 * Имён пациентов здесь нет ни в одном ответе: только числа и разрезы (§7).
 * Врачи — по именам: это не персональные данные пациента.
 */

const DAY = 24 * 3600_000;
const WEEKDAYS = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "дата в виде ГГГГ-ММ-ДД");
const range = z.object({ date_from: isoDay, date_to: isoDay });

/** Отрезок теми же границами, что отчёты: ключ «dГГГГ-ММ-ДД..ГГГГ-ММ-ДД». */
function bounds(a: { date_from: string; date_to: string }) {
  const key = `d${a.date_from}..${a.date_to}`;
  const { from, to } = periodBounds(key);
  if (!(from < to)) throw new Error("конец отрезка раньше начала");
  if (to.getTime() - from.getTime() > 400 * DAY) throw new Error("отрезок длиннее 400 дней — разбейте на части");
  return { key, from, to };
}
const rub = (n: number) => Math.round(n);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const hours = (min: number) => Math.round((min / 60) * 10) / 10;

const PERIOD_PROPS = {
  date_from: { type: "string", description: "Начало отрезка, ГГГГ-ММ-ДД (включительно)" },
  date_to: { type: "string", description: "Конец отрезка, ГГГГ-ММ-ДД (включительно)" },
};

export const ANALYST_TOOLS = [
  {
    name: "clinic_metrics",
    description:
      "Итоги клиники за любой отрезок — те же числа, что в «Отчётах»: выручка (визиты + проданные курсы), средний чек, приёмы (первичные, повторные, сеансы курсов), новые пациенты, воронка обращений, неявки и неразобранные визиты, источники, разрез по специалистам.",
    parameters: { type: "object", properties: PERIOD_PROPS, required: ["date_from", "date_to"] },
  },
  {
    name: "room_idle_loss",
    description:
      "Простой кабинетов и деньги, которые он стоит: рабочие часы по графику клиники, занятые и пустые часы каждого кабинета, стоимость часа работы кабинета и упущенная выручка, если бы пустые часы работали так же; где простой больше всего — по дням недели и часам.",
    parameters: { type: "object", properties: PERIOD_PROPS, required: ["date_from", "date_to"] },
  },
  {
    name: "load_heatmap",
    description:
      "Загрузка клиники по дням недели и часам за отрезок: доля занятого времени кабинетов в каждом часе. Показывает пиковые и пустые часы — куда ставить акции, где не хватает мест.",
    parameters: { type: "object", properties: PERIOD_PROPS, required: ["date_from", "date_to"] },
  },
  {
    name: "staff_breakdown",
    description:
      "Работа каждого специалиста за отрезок: приёмы, выручка, средний чек, первичные, неявки и отмены, уникальные пациенты, часы работы и выручка за час, доля возвращающихся пациентов.",
    parameters: { type: "object", properties: PERIOD_PROPS, required: ["date_from", "date_to"] },
  },
  {
    name: "service_breakdown",
    description:
      "Услуги за отрезок: сколько приёмов, сколько денег, средняя цена, сколько разных пациентов, доля в выручке. Помогает понять, на чём клиника зарабатывает.",
    parameters: { type: "object", properties: PERIOD_PROPS, required: ["date_from", "date_to"] },
  },
  {
    name: "losses_no_show_cancel",
    description:
      "Потери от неявок и отмен за отрезок: число и деньги (стоимость пропавших приёмов), поздние отмены (меньше чем за сутки), разрез по специалистам и дням недели, неразобранные визиты без отметки.",
    parameters: { type: "object", properties: PERIOD_PROPS, required: ["date_from", "date_to"] },
  },
  {
    name: "compare_periods",
    description:
      "Сравнение двух отрезков по ключевым числам с разницей в рублях/штуках и процентах: выручка, средний чек, приёмы, новые пациенты, неявки, обращения, проданные курсы.",
    parameters: {
      type: "object",
      properties: {
        a_from: { type: "string", description: "Отрезок A: начало, ГГГГ-ММ-ДД" },
        a_to: { type: "string", description: "Отрезок A: конец, ГГГГ-ММ-ДД" },
        b_from: { type: "string", description: "Отрезок B: начало, ГГГГ-ММ-ДД" },
        b_to: { type: "string", description: "Отрезок B: конец, ГГГГ-ММ-ДД" },
      },
      required: ["a_from", "a_to", "b_from", "b_to"],
    },
  },
  {
    name: "retention",
    description:
      "Удержание и отток: сколько новых пациентов за отрезок пришли повторно (в течение 60 дней), сколько «спящих» пациентов (давно не были и не записаны) и сколько они приносили в среднем — потенциал возврата.",
    parameters: { type: "object", properties: PERIOD_PROPS, required: ["date_from", "date_to"] },
  },
  {
    name: "courses_overview",
    description:
      "Курсы на сегодня: идут, пройдены, выпали из графика; оплаченные и не проведённые сеансы в рублях (обязательства, не выручка); у выпавших — сколько денег висит.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "future_bookings",
    description:
      "Что уже записано вперёд на N дней: число записей и плановая сумма по прайсу (план, не выручка), по специалистам и по дням, загрузка кабинетов вперёд — где ещё есть место.",
    parameters: {
      type: "object",
      properties: { days: { type: "integer", description: "На сколько дней вперёд, 1–60" } },
      required: ["days"],
    },
  },
  {
    name: "callback_queue",
    description:
      "Рабочая очередь «Кому позвонить» без имён: сколько человек по каждому поводу (выпал из курса, курс на финише, не пришёл, давно не был) и сколько денег за ними стоит; что дал обзвон за 30 дней.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "calculate",
    description:
      "Калькулятор. Любая арифметика — только через него: проценты, разницы, доли, «если вырастет на 10%». Выражение из чисел, + - * / ( ) и %.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string", description: "Например: (1745400 - 1900500) / 1900500 * 100" } },
      required: ["expression"],
    },
  },
] as const;

export type AnalystToolName = (typeof ANALYST_TOOLS)[number]["name"];

/** Формат инструментов для OpenAI-совместимого API провайдера. */
export function toolSpecs() {
  return ANALYST_TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// ───────────────────────────────────────────── расчёты

async function clinicMetrics(companyId: string, args: unknown) {
  const { key } = bounds(range.parse(args));
  const [m, att] = await Promise.all([getDashboardMetricsDb(companyId, key), (async () => {
    const { from, to } = bounds(range.parse(args));
    return attendanceBetween(companyId, from, to);
  })()]);
  return {
    период: m.period.label,
    рабочихДней: m.period.workingDays,
    выручка: rub(m.money.revenue),
    изНихПроданныеКурсы: rub(m.money.courseRevenue),
    курсовПродано: m.money.coursesSold,
    среднийЧек: rub(m.money.avgCheck),
    новыхПациентов: m.money.newPatients,
    приёмы: { состоялось: m.visitMix.total, первичных: m.visitMix.first, повторных: m.visitMix.returned, сеансовКурса: m.visitMix.courseSession },
    воронка: { обращений: m.funnel.inquiries, записались: m.funnel.booked, пришли: m.funnel.arrived, записейСозданоВПериоде: m.bookedInPeriod },
    изПереписки: m.fromDialog ?? null,
    разобранность: att,
    источники: m.sources.map((s) => ({ источник: s.title, обращений: s.inquiries, записей: s.booked })),
    специалисты: m.staff.map((s) => ({ имя: s.name, приёмов: s.appointments, выручка: rub(s.revenue), среднийЧек: rub(s.avgCheck), доляВыручки: Math.round(s.revenueShare * 1000) / 10 })),
  };
}

/** Стоимость приёма: сумма записи, а сеанс курса — по цене сеанса в курсе (деньги взяты при продаже). */
async function appointmentsWithValue(companyId: string, from: Date, to: Date, statuses: ("ARRIVED" | "NO_SHOW" | "CANCELLED" | "CREATED" | "CONFIRMED")[]) {
  const rows = await prisma.appointment.findMany({
    where: { companyId, deletedAt: null, startAt: { gte: from, lt: to }, status: { in: statuses } },
    select: {
      id: true, status: true, startAt: true, durationMin: true, roomId: true, staffId: true, patientId: true,
      revenue: true, revenueSource: true, isFirstVisit: true, cancelledAt: true,
      course: { select: { pricePerSession: true } },
      primaryService: { select: { title: true, price: true } },
    },
  });
  return rows.map((r) => {
    const record = Number(r.revenue);
    const value = record > 0 ? record : r.course ? Number(r.course.pricePerSession) : Number(r.primaryService?.price ?? 0);
    return { ...r, record, value, courseSession: record === 0 && !!r.course };
  });
}

async function roomIdleLoss(companyId: string, args: unknown) {
  const b = bounds(range.parse(args));
  // Простой бывает только в прошлом: будущие пустые часы — это ещё не потеря.
  const to = new Date(Math.min(b.to.getTime(), Date.now()));
  if (to <= b.from) throw new Error("отрезок целиком в будущем — простоя ещё не было");
  const [occ, appts, schedule, closed, rooms] = await Promise.all([
    roomOccupancyBetween(companyId, b.from, to),
    appointmentsWithValue(companyId, b.from, to, ["ARRIVED"]),
    loadSchedule(companyId),
    closedDatesBetween(companyId, b.from, to),
    prisma.room.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true } }),
  ]);

  // Пустые часы по дням недели и часам — где именно простой.
  const busyBySlot = new Map<string, number>();
  const openBySlot = new Map<string, number>();
  for (let t = b.from.getTime(); t < to.getTime(); t += DAY) {
    const day = new Date(t);
    const interval = dayInterval(schedule, day);
    if (!interval || closed.has(isoDate(day))) continue;
    const wd = clinicWeekday(day);
    for (let m = interval.startMinute; m < interval.endMinute; m += 60) {
      const k = `${wd}|${Math.floor(m / 60)}`;
      openBySlot.set(k, (openBySlot.get(k) ?? 0) + Math.min(60, interval.endMinute - m) * rooms.length);
    }
  }
  for (const a of appts) {
    let m = minuteOfDay(a.startAt);
    let left = a.durationMin;
    const wd = clinicWeekday(a.startAt);
    while (left > 0) {
      const h = Math.floor(m / 60);
      const take = Math.min(left, (h + 1) * 60 - m);
      const k = `${wd}|${h}`;
      busyBySlot.set(k, (busyBySlot.get(k) ?? 0) + take);
      left -= take;
      m += take;
    }
  }

  const perRoom = occ.map((r) => {
    const inRoom = appts.filter((a) => a.roomId === r.roomId);
    const valueMin = inRoom.reduce((s, a) => s + a.durationMin, 0);
    const value = inRoom.reduce((s, a) => s + a.value, 0);
    const perHour = valueMin > 0 ? (value / valueMin) * 60 : 0;
    const idle = Math.max(0, r.availableMinutes - r.busyMinutes);
    return {
      кабинет: r.name,
      рабочихЧасов: hours(r.availableMinutes),
      занятоЧасов: hours(r.busyMinutes),
      пустыхЧасов: hours(idle),
      загрузкаПроцент: Math.round(r.rate * 1000) / 10,
      стоимостьЧасаРаботы: rub(perHour),
      упущеноЕслиБыПустыеЧасыРаботалиТакЖе: rub(hours(idle) * perHour),
    };
  });
  const idleSlots = [...openBySlot.entries()]
    .map(([k, open]) => {
      const [wd, h] = k.split("|").map(Number);
      const busy = busyBySlot.get(k) ?? 0;
      return { когда: `${WEEKDAYS[wd]} ${h}:00–${h + 1}:00`, пустыхЧасов: hours(Math.max(0, open - busy)), загрузкаПроцент: pct(busy, open) };
    })
    .sort((x, y) => y.пустыхЧасов - x.пустыхЧасов);
  return {
    отрезок: `${isoDate(b.from)} — ${isoDate(new Date(to.getTime() - 1))}`,
    кабинеты: perRoom,
    итогоПустыхЧасов: Math.round(perRoom.reduce((s, r) => s + r.пустыхЧасов, 0) * 10) / 10,
    итогоУпущено: rub(perRoom.reduce((s, r) => s + r.упущеноЕслиБыПустыеЧасыРаботалиТакЖе, 0)),
    большеВсегоПростояВ: idleSlots.slice(0, 8),
    меньшеВсегоПростояВ: idleSlots.slice(-5).reverse(),
    какСчитано:
      "Стоимость часа — сумма проведённых приёмов кабинета, делённая на их часы (сеанс курса — по цене сеанса в курсе). " +
      "«Упущено» — верхняя граница: столько принесли бы пустые часы при той же стоимости часа и полном заполнении. Реалистично заполнить часть — посчитайте через calculate.",
  };
}

async function loadHeatmap(companyId: string, args: unknown) {
  const r = (await roomIdleLoss(companyId, args)) as { большеВсегоПростояВ: unknown; меньшеВсегоПростояВ: unknown };
  const b = bounds(range.parse(args));
  const to = new Date(Math.min(b.to.getTime(), Date.now()));
  const appts = await appointmentsWithValue(companyId, b.from, to, ["ARRIVED", "NO_SHOW"]);
  const byWeekday = new Map<number, { visits: number; value: number; noShow: number }>();
  for (const a of appts) {
    const wd = clinicWeekday(a.startAt);
    const x = byWeekday.get(wd) ?? { visits: 0, value: 0, noShow: 0 };
    if (a.status === "ARRIVED") {
      x.visits += 1;
      x.value += a.value;
    } else x.noShow += 1;
    byWeekday.set(wd, x);
  }
  return {
    самыеПустыеЧасы: r.большеВсегоПростояВ,
    самыеЗагруженныеЧасы: r.меньшеВсегоПростояВ,
    поДнямНедели: [...byWeekday.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([wd, x]) => ({ день: WEEKDAYS[wd], приёмов: x.visits, стоимостьПриёмов: rub(x.value), неявок: x.noShow })),
  };
}

async function staffBreakdown(companyId: string, args: unknown) {
  const b = bounds(range.parse(args));
  const [m, appts, staff] = await Promise.all([
    getDashboardMetricsDb(companyId, b.key),
    appointmentsWithValue(companyId, b.from, b.to, ["ARRIVED", "NO_SHOW", "CANCELLED"]),
    prisma.staff.findMany({ where: { companyId, deletedAt: null }, select: { id: true, name: true, specialty: true } }),
  ]);
  // Возвращаются ли: был ли у пациента этого врача ещё визит до конца отрезка или после.
  const later = await prisma.appointment.findMany({
    where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: b.from } },
    select: { patientId: true, staffId: true, startAt: true },
  });
  return staff
    .map((s) => {
      const mine = appts.filter((a) => a.staffId === s.id);
      const arrived = mine.filter((a) => a.status === "ARRIVED");
      if (mine.length === 0) return null;
      const stat = m.staff.find((x) => x.staffId === s.id);
      const minutes = arrived.reduce((t, a) => t + a.durationMin, 0);
      const value = arrived.reduce((t, a) => t + a.value, 0);
      const patients = new Set(arrived.map((a) => a.patientId));
      const returned = [...patients].filter((p) => later.filter((l) => l.patientId === p && l.staffId === s.id).length > 1).length;
      return {
        специалист: s.name,
        специальность: s.specialty,
        приёмовСостоялось: arrived.length,
        выручка: rub(stat?.revenue ?? arrived.reduce((t, a) => t + a.record, 0)),
        среднийЧек: rub(stat?.avgCheck ?? 0),
        стоимостьПроведённыхПриёмов: rub(value),
        первичных: arrived.filter((a) => a.isFirstVisit).length,
        неявок: mine.filter((a) => a.status === "NO_SHOW").length,
        отмен: mine.filter((a) => a.status === "CANCELLED").length,
        разныхПациентов: patients.size,
        пришлиКНемуПовторноПроцент: pct(returned, patients.size),
        часовРаботы: hours(minutes),
        стоимостьЧаса: minutes > 0 ? rub((value / minutes) * 60) : 0,
      };
    })
    .filter(Boolean);
}

async function serviceBreakdown(companyId: string, args: unknown) {
  const b = bounds(range.parse(args));
  const rows = await prisma.appointmentService.findMany({
    where: { companyId, appointment: { deletedAt: null, status: "ARRIVED", startAt: { gte: b.from, lt: b.to } } },
    select: { priceCharged: true, service: { select: { title: true } }, appointment: { select: { patientId: true } } },
  });
  const sales = await prisma.coursePurchase.findMany({
    where: { companyId, purchasedAt: { gte: b.from, lt: b.to } },
    select: { amount: true, service: { select: { title: true } } },
  });
  const map = new Map<string, { visits: number; money: number; patients: Set<string>; courseSales: number; courseMoney: number }>();
  for (const r of rows) {
    const x = map.get(r.service.title) ?? { visits: 0, money: 0, patients: new Set<string>(), courseSales: 0, courseMoney: 0 };
    x.visits += 1;
    x.money += Number(r.priceCharged);
    x.patients.add(r.appointment.patientId);
    map.set(r.service.title, x);
  }
  for (const s of sales) {
    const title = s.service?.title ?? "курс (услуга не определена)";
    const x = map.get(title) ?? { visits: 0, money: 0, patients: new Set<string>(), courseSales: 0, courseMoney: 0 };
    x.courseSales += 1;
    x.courseMoney += Number(s.amount);
    map.set(title, x);
  }
  const total = [...map.values()].reduce((t, x) => t + x.money + x.courseMoney, 0);
  return [...map.entries()]
    .map(([title, x]) => ({
      услуга: title,
      приёмов: x.visits,
      деньгиПриёмов: rub(x.money),
      продажКурса: x.courseSales,
      деньгиПродажКурса: rub(x.courseMoney),
      средняяЦенаПриёма: x.visits ? rub(x.money / x.visits) : 0,
      разныхПациентов: x.patients.size,
      доляВыручкиПроцент: pct(x.money + x.courseMoney, total),
    }))
    .sort((a, c) => c.деньгиПриёмов + c.деньгиПродажКурса - (a.деньгиПриёмов + a.деньгиПродажКурса))
    .slice(0, 30);
}

async function losses(companyId: string, args: unknown) {
  const b = bounds(range.parse(args));
  const [appts, staff, att] = await Promise.all([
    appointmentsWithValue(companyId, b.from, b.to, ["NO_SHOW", "CANCELLED", "ARRIVED"]),
    prisma.staff.findMany({ where: { companyId }, select: { id: true, name: true } }),
    attendanceBetween(companyId, b.from, b.to),
  ]);
  const lost = appts.filter((a) => a.status !== "ARRIVED");
  const late = lost.filter((a) => a.status === "CANCELLED" && a.cancelledAt && a.startAt.getTime() - a.cancelledAt.getTime() < DAY);
  const sum = (xs: typeof lost) => rub(xs.reduce((t, a) => t + a.value, 0));
  const byStaff = staff
    .map((s) => {
      const x = lost.filter((a) => a.staffId === s.id);
      const all = appts.filter((a) => a.staffId === s.id);
      return { специалист: s.name, неявок: x.filter((a) => a.status === "NO_SHOW").length, отмен: x.filter((a) => a.status === "CANCELLED").length, стоимость: sum(x), доляОтВсехЗаписейПроцент: pct(x.length, all.length) };
    })
    .filter((x) => x.неявок + x.отмен > 0);
  const byWeekday = [1, 2, 3, 4, 5, 6, 7]
    .map((wd) => {
      const x = lost.filter((a) => clinicWeekday(a.startAt) === wd);
      return { день: WEEKDAYS[wd], неявок: x.filter((a) => a.status === "NO_SHOW").length, отмен: x.filter((a) => a.status === "CANCELLED").length, стоимость: sum(x) };
    })
    .filter((x) => x.неявок + x.отмен > 0);
  return {
    неявок: lost.filter((a) => a.status === "NO_SHOW").length,
    стоимостьНеявок: sum(lost.filter((a) => a.status === "NO_SHOW")),
    отмен: lost.filter((a) => a.status === "CANCELLED").length,
    стоимостьОтмен: sum(lost.filter((a) => a.status === "CANCELLED")),
    позднихОтменМеньшеЧемЗаСутки: late.length,
    стоимостьПозднихОтмен: sum(late),
    неявкиИОтменыОтВсехЗаписейПроцент: pct(lost.length, appts.length),
    поСпециалистам: byStaff,
    поДнямНедели: byWeekday,
    неразобранныеВизиты: att,
    какСчитано: "Стоимость — сумма записи, у сеанса курса — цена сеанса. Отменённое время часто занимают другие пациенты, поэтому это верхняя граница потерь.",
  };
}

async function comparePeriods(companyId: string, args: unknown) {
  const p = z.object({ a_from: isoDay, a_to: isoDay, b_from: isoDay, b_to: isoDay }).parse(args);
  const [a, c] = await Promise.all([
    clinicMetrics(companyId, { date_from: p.a_from, date_to: p.a_to }),
    clinicMetrics(companyId, { date_from: p.b_from, date_to: p.b_to }),
  ]);
  const pick = (m: Awaited<ReturnType<typeof clinicMetrics>>) => ({
    выручка: m.выручка,
    проданныеКурсы: m.изНихПроданныеКурсы,
    среднийЧек: m.среднийЧек,
    приёмов: m.приёмы.состоялось,
    первичных: m.приёмы.первичных,
    новыхПациентов: m.новыхПациентов,
    обращений: m.воронка.обращений,
    курсовПродано: m.курсовПродано,
    рабочихДней: m.рабочихДней,
  });
  const A = pick(a);
  const B = pick(c);
  const diff = Object.fromEntries(
    (Object.keys(A) as (keyof typeof A)[]).map((k) => [k, { разница: B[k] - A[k], процент: A[k] ? Math.round(((B[k] - A[k]) / A[k]) * 1000) / 10 : null }]),
  );
  return { A: { отрезок: a.период, ...A }, B: { отрезок: c.период, ...B }, изменениеОтAкB: diff };
}

async function retention(companyId: string, args: unknown) {
  const b = bounds(range.parse(args));
  const now = Date.now();
  const arrived = await prisma.appointment.findMany({
    where: { companyId, deletedAt: null, status: "ARRIVED" },
    select: { patientId: true, startAt: true, revenue: true },
    orderBy: { startAt: "asc" },
  });
  const future = new Set(
    (
      await prisma.appointment.findMany({
        where: { companyId, deletedAt: null, startAt: { gt: new Date() }, status: { in: ["CREATED", "CONFIRMED"] } },
        select: { patientId: true },
      })
    ).map((x) => x.patientId),
  );
  const byPatient = new Map<string, { first: number; dates: number[]; money: number }>();
  for (const a of arrived) {
    const x = byPatient.get(a.patientId) ?? { first: a.startAt.getTime(), dates: [], money: 0 };
    x.dates.push(a.startAt.getTime());
    x.money += Number(a.revenue);
    byPatient.set(a.patientId, x);
  }
  const newcomers = [...byPatient.values()].filter((x) => x.first >= b.from.getTime() && x.first < b.to.getTime());
  const matured = newcomers.filter((x) => now - x.first >= 60 * DAY);
  const returned60 = matured.filter((x) => x.dates.some((d) => d > x.first && d - x.first <= 60 * DAY));
  const returnedAny = newcomers.filter((x) => x.dates.length > 1);
  const sleeping = [...byPatient.entries()].filter(([id, x]) => {
    const last = x.dates[x.dates.length - 1];
    return now - last > 90 * DAY && now - last < 365 * DAY && !future.has(id);
  });
  const sleepingMoney = sleeping.reduce((t, [, x]) => t + x.money, 0);
  return {
    новыхПациентовВОтрезке: newcomers.length,
    изНихПришлиЕщёРаз: returnedAny.length,
    вернулисьВ60ДнейПроцент: matured.length ? pct(returned60.length, matured.length) : null,
    оценкаВ60ДнейПоСкольким: matured.length,
    спящих_90_365_днейБезЗаписи: sleeping.length,
    спящиеПринеслиЗаВсёВремя: rub(sleepingMoney),
    спящиеВСреднемНаЧеловека: sleeping.length ? rub(sleepingMoney / sleeping.length) : 0,
    какСчитано: "«Спящий» — последний визит 90–365 дней назад и нет будущей записи. Возврат в 60 дней считается только по тем, у кого 60 дней уже прошло.",
  };
}

async function coursesOverview(companyId: string) {
  const courses = await prisma.course.findMany({
    where: { companyId },
    select: {
      status: true, sessionsTotal: true, sessionsUsed: true, sessionsBooked: true, pricePerSession: true, amount: true, patientId: true, serviceId: true,
      service: { select: { title: true, stalledAfterDays: true } },
    },
  });
  const queue = await getCallbackQueue(companyId);
  const stalledIds = new Set(queue.rows.filter((r) => r.kind === "COURSE_STALLED").map((r) => r.courseId));
  const active = courses.filter((c) => c.status === "ACTIVE");
  const left = (c: (typeof courses)[number]) => Math.max(0, c.sessionsTotal - c.sessionsUsed) * Number(c.pricePerSession);
  const stalledMoney = queue.rows.filter((r) => r.kind === "COURSE_STALLED").reduce((t, r) => t + (r.money ?? 0), 0);
  return {
    идут: active.length,
    пройдены: courses.filter((c) => c.status === "COMPLETED").length,
    выпалиИзГрафика: stalledIds.size,
    оплаченоНоНеПроведеноРублей: rub(active.reduce((t, c) => t + left(c), 0)),
    уВыпавшихВиситРублей: rub(stalledMoney),
    записаныВпередНаСеансов: active.reduce((t, c) => t + c.sessionsBooked, 0),
    поУслугам: [...new Set(courses.map((c) => c.service.title))].map((title) => {
      const xs = courses.filter((c) => c.service.title === title);
      return { услуга: title, курсов: xs.length, идут: xs.filter((c) => c.status === "ACTIVE").length, пройдены: xs.filter((c) => c.status === "COMPLETED").length };
    }),
    важно: "Оплаченные и не проведённые сеансы — обязательства клиники, а не выручка: деньги уже посчитаны в день продажи.",
  };
}

async function futureBookings(companyId: string, args: unknown) {
  const { days } = z.object({ days: z.number().int().min(1).max(60) }).parse(args);
  const from = new Date();
  const to = new Date(from.getTime() + days * DAY);
  const [appts, occ, staff] = await Promise.all([
    appointmentsWithValue(companyId, from, to, ["CREATED", "CONFIRMED"]),
    roomOccupancyBetween(companyId, from, to),
    prisma.staff.findMany({ where: { companyId }, select: { id: true, name: true } }),
  ]);
  const byDay = new Map<string, { n: number; v: number }>();
  for (const a of appts) {
    const k = `${isoDate(a.startAt)} ${WEEKDAYS[clinicWeekday(a.startAt)]}`;
    const x = byDay.get(k) ?? { n: 0, v: 0 };
    x.n += 1;
    x.v += a.courseSession ? 0 : a.value;
    byDay.set(k, x);
  }
  return {
    дней: days,
    записей: appts.length,
    изНихСеансовКурса: appts.filter((a) => a.courseSession).length,
    плановаяСуммаПоПрайсу: rub(appts.filter((a) => !a.courseSession).reduce((t, a) => t + a.value, 0)),
    поСпециалистам: staff
      .map((s) => ({ специалист: s.name, записей: appts.filter((a) => a.staffId === s.id).length }))
      .filter((x) => x.записей > 0),
    поДням: [...byDay.entries()].sort().map(([d, x]) => ({ день: d, записей: x.n, план: rub(x.v) })),
    загрузкаКабинетовВперёд: occ.map((r) => ({ кабинет: r.name, занятоПроцент: Math.round(r.rate * 1000) / 10, свободноЧасов: hours(Math.max(0, r.availableMinutes - r.busyMinutes)) })),
    важно: "План — не выручка: часть записей отменят, сеансы курса денег дня не приносят.",
  };
}

async function callbackQueue(companyId: string) {
  const q = await getCallbackQueue(companyId);
  const kinds: Record<string, string> = { COURSE_STALLED: "выпал из курса", COURSE_FINISHING: "курс на финише", NO_SHOW: "не пришёл", SLEEPING: "давно не был" };
  return {
    поводы: Object.entries(kinds).map(([k, label]) => {
      const xs = q.rows.filter((r) => r.kind === k);
      return { повод: label, человек: xs.length, денег: rub(xs.reduce((t, r) => t + (r.money ?? 0), 0)) };
    }),
    безПорогаВНастройках: q.withoutThreshold,
    результатОбзвона: q.outcome,
  };
}

/** Выполнить вызов модели. Ошибка — словами: модель передаст её владельцу. */
export async function runAnalystTool(companyId: string, name: string, rawArgs: string): Promise<string> {
  let args: unknown = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return JSON.stringify({ ошибка: "аргументы не разобрались как JSON" });
  }
  try {
    const result = await (async () => {
      switch (name as AnalystToolName) {
        case "clinic_metrics": return clinicMetrics(companyId, args);
        case "room_idle_loss": return roomIdleLoss(companyId, args);
        case "load_heatmap": return loadHeatmap(companyId, args);
        case "staff_breakdown": return staffBreakdown(companyId, args);
        case "service_breakdown": return serviceBreakdown(companyId, args);
        case "losses_no_show_cancel": return losses(companyId, args);
        case "compare_periods": return comparePeriods(companyId, args);
        case "retention": return retention(companyId, args);
        case "courses_overview": return coursesOverview(companyId);
        case "future_bookings": return futureBookings(companyId, args);
        case "callback_queue": return callbackQueue(companyId);
        case "calculate": {
          const { expression } = z.object({ expression: z.string().max(300) }).parse(args);
          return { выражение: expression, результат: calculate(expression) };
        }
        default:
          return { ошибка: `нет такого расчёта: ${name}` };
      }
    })();
    return JSON.stringify(result);
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues.map((i) => i.message).join("; ") : (e as Error)?.message ?? String(e);
    return JSON.stringify({ ошибка: msg.slice(0, 300) });
  }
}
