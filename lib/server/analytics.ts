import { prisma } from "@/lib/db";
import { buildFunnel } from "@/lib/metrics/funnel";
import { busyMinutes, freeGaps, occupancyRate, type Interval } from "@/lib/metrics/occupancy";
import { countInquiriesFromDb } from "@/lib/metrics/inquiries";
import { averageCheck, withSourceShares, withStaffShares } from "@/lib/metrics/summary";
import { closedDatesBetween } from "@/lib/server/clinic-day";
import { startOfClinicDay } from "@/lib/clinic-time";
import {
  isMonthKey,
  isWeekKey,
  monthBounds,
  monthLabel,
  weekBounds,
  weekKeyOf,
  weekLabel,
} from "@/lib/metrics/types";
import type {
  DashboardMetrics,
  PeriodKey,
  RoomDay,
  RoomInterval,
  SourceStat,
  StaffStat,
} from "@/lib/metrics/types";

/**
 * Отчёты из базы.
 *
 * Раздел читал lib/mock-metrics — выдуманный набор с зафиксированной датой
 * 22 июля. Числа там не совпадали ни с «Сегодня», ни с кабинетом владельца,
 * ни с карточкой специалиста, и совпасть не могли: базу этот код не открывал
 * вообще. Форма ответа сохранена (DashboardMetrics), поэтому экран не
 * изменился — сменился только источник.
 *
 * Определения взяты из §8 CLAUDE.md и совпадают с остальными экранами:
 * записавшиеся — визиты со статусом ≠ CANCELLED, пришедшие — ARRIVED,
 * первичные — первый визит пациента со статусом ARRIVED.
 */

const PERIOD_DAYS: Record<string, number> = { month: 30, quarter: 90 };
const PERIOD_LABEL: Record<string, string> = {
  week: "Прошлая неделя",
  month: "Месяц",
  quarter: "Квартал",
};

/**
 * Границы периода.
 *
 * Скользящее окно доходит до конца текущих суток: верхняя граница «сейчас»
 * отсекала визиты, которые администратор уже отметил состоявшимися, но время
 * которых по расписанию ещё не прошло — отметка «пришёл» не меняла отчёт.
 *
 * Календарный месяц берётся целиком, включая будущие дни: за май смотрят
 * итоги мая, а не «мая до сегодня».
 */
export function periodBounds(period: PeriodKey, now: Date = new Date()): { from: Date; to: Date } {
  if (isMonthKey(period)) return monthBounds(period);
  // Календарная неделя: тот же отрезок, что показывает столбец графика.
  if (isWeekKey(period)) return weekBounds(period);

  /**
   * «Неделя» — последняя ПОЛНАЯ календарная неделя, та же, что последний
   * столбец графика у владельца.
   *
   * Здесь были последние семь дней до сегодня. График показывает полные недели
   * с понедельника, и под одним словом «неделя» стояли 205 тысяч и 215. Ссылка
   * со столбца в отчёт этого не лечит: владелец сравнивает то, что открыто
   * перед ним, а не то, что можно открыть по ссылке. Значит слово «неделя»
   * обязано означать один и тот же отрезок на обоих экранах.
   */
  if (period === "week") {
    return weekBounds(weekKeyOf(new Date(now.getTime() - 7 * 24 * 3600 * 1000)));
  }

  /**
   * Скользящее окно — ровно N календарных суток клиники.
   *
   * Начало бралось как «сейчас минус тридцать суток», то есть с середины дня:
   * период охватывал тридцать дней плюс остаток сегодняшнего, и подпись честно
   * показывала тридцать одну дату под словом «месяц».
   */
  const days = PERIOD_DAYS[period] ?? 30;
  const from = startOfClinicDay(new Date(now.getTime() - (days - 1) * 24 * 3600 * 1000));
  return { from, to: endOfToday(now) };
}

/** Подпись периода для экрана. */
export function periodLabel(period: PeriodKey): string {
  if (isMonthKey(period)) return monthLabel(period);
  if (isWeekKey(period)) return weekLabel(period);
  return PERIOD_LABEL[period] ?? period;
}

/**
 * График клиники по дням недели.
 *
 * Раньше рабочий день был зашит константой 9:00–21:00 — двенадцать часов. У
 * клиники в справочнике другой график: будни 08:00–16:00, суббота 09:00–16:00.
 * Загрузка кабинетов делилась на интервал в полтора раза больший, чем
 * настоящий, и все три кабинета выглядели простаивающими.
 *
 * Теперь знаменатель берётся из «Настройки → Клиника». Пустое расписание —
 * повод показать это честно, а не подставить выдуманные часы: см. FALLBACK_DAY.
 */
type Schedule = Map<number, Interval>;

/**
 * Если расписание не заполнено вовсе. Двенадцать часов — прежнее поведение:
 * загрузка будет занижена, но экран не сломается и не покажет 100%.
 */
const FALLBACK_DAY: Interval = { startMinute: 9 * 60, endMinute: 21 * 60 };

async function loadSchedule(companyId: string): Promise<Schedule> {
  const rows = await prisma.clinicSchedule.findMany({
    where: { companyId },
    select: { weekday: true, startMinute: true, endMinute: true },
  });
  const map: Schedule = new Map();
  for (const r of rows) {
    if (r.endMinute > r.startMinute) {
      map.set(r.weekday, { startMinute: r.startMinute, endMinute: r.endMinute });
    }
  }
  return map;
}

/** Рабочий интервал конкретного дня. Нет в расписании — клиника закрыта. */
/**
 * День недели в зоне клиники, 1 = понедельник … 7 = воскресенье.
 *
 * Здесь стоял `date.getDay()` — день недели по часам сервера. Границы периода
 * строятся по полуночи клиники (для Москвы это 21:00 UTC предыдущих суток), и
 * на сервере в UTC весь перебор дней съезжал на сутки назад: график субботы
 * применялся к пятнице, а закрытое воскресенье выпадало на субботу.
 */
function clinicWeekday(date: Date, tz = "Europe/Moscow"): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date);
  const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return order.indexOf(name) + 1;
}

function dayInterval(schedule: Schedule, date: Date): Interval | null {
  if (schedule.size === 0) return FALLBACK_DAY;
  return schedule.get(clinicWeekday(date)) ?? null;
}

/**
 * Рабочие минуты клиники за период — сумма по дням её собственного графика.
 * Закрытые даты (праздники) в знаменатель не идут: иначе кабинеты выглядят
 * простаивающими ровно на эти дни.
 */
export function workingMinutesBetween(
  from: Date,
  to: Date,
  schedule: Schedule,
  closed?: Set<string>,
): number {
  let minutes = 0;
  const cursor = new Date(from);
  while (cursor < to) {
    /**
     * Дату дня берём в зоне клиники.
     *
     * Здесь стояло `toISOString().slice(0, 10)` — дата в UTC. Период считается
     * от полуночи клиники, то есть от 21:00 предыдущих суток по UTC, поэтому
     * ключ всегда получался на день раньше и ни разу не совпадал с датами
     * закрытых дней. Праздники и санитарные дни в знаменатель загрузки
     * попадали все до одного, и кабинеты выглядели простаивающими ровно на те
     * дни, когда клиника была закрыта.
     */
    const key = isoDate(cursor);
    const day = dayInterval(schedule, cursor);
    if (day && !closed?.has(key)) minutes += day.endMinute - day.startMinute;
    cursor.setTime(cursor.getTime() + 24 * 3600 * 1000);
  }
  return minutes;
}

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

function isoDate(at: Date, tz = "Europe/Moscow"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * Конец текущих суток в зоне клиники: граница отчётного окна.
 *
 * Подпись обещала зону клиники, а `setHours` брал часы сервера. На сервере в
 * UTC период заканчивался в 02:59 следующего дня по клинике и прихватывал
 * лишние сутки в знаменатель загрузки.
 */
/**
 * Докуда считать знаменатель периода.
 *
 * Скользящее окно — до сегодня. Календарный месяц или неделя — до конца этого
 * отрезка, иначе средние за май считались бы по неполному маю. Но не дальше
 * сегодняшнего дня: у текущего месяца в знаменатель уходили ещё не наступившие
 * дни, и загрузка кабинетов в нём выглядела вдвое ниже настоящей просто
 * потому, что месяц не кончился.
 */
function denominatorEnd(period: PeriodKey, from: Date, to: Date, now: Date): Date {
  // «Неделя» — тоже календарный отрезок: последняя полная неделя.
  const calendar = isMonthKey(period) || isWeekKey(period) || period === "week";
  const end = calendar ? to : now;
  const today = endOfToday(now);
  if (end > today) return today > from ? today : from;
  return end;
}

function endOfToday(now: Date): Date {
  return new Date(startOfClinicDay(now).getTime() + 24 * 3600 * 1000 - 1);
}

/**
 * Рабочих дней в периоде: клиника не работает по воскресеньям и в дни, которые
 * отмечены исключением как закрытые (праздник, санитарный день).
 *
 * Без учёта исключений праздники попадали в знаменатель загрузки, и она
 * занижалась ровно на эти дни — кабинеты выглядели простаивающими, хотя
 * клиника была закрыта.
 */
export function workingDaysBetween(from: Date, to: Date, closed?: Set<string>): number {
  let count = 0;
  const cursor = new Date(from);
  while (cursor < to) {
    // Дата и день недели — в зоне клиники, как и в рабочих минутах выше.
    const key = isoDate(cursor);
    if (clinicWeekday(cursor) !== 7 && !closed?.has(key)) count += 1;
    cursor.setTime(cursor.getTime() + 24 * 3600 * 1000);
  }
  return count;
}

export async function getDashboardMetricsDb(
  companyId: string,
  period: PeriodKey,
): Promise<DashboardMetrics> {
  /**
   * Границы периода — по дате визита, а состоявшееся — по статусу.
   *
   * Верхняя граница «сейчас» отсекала визиты, которые администратор уже
   * отметил как состоявшиеся, но время которых по расписанию ещё не прошло:
   * отметка «пришёл» не меняла отчёт. Поэтому окно доходит до конца текущих
   * суток, а план от факта отделяет статус.
   */
  const now = new Date();
  const { from, to } = periodBounds(period, now);

  const [appts, inquiries, newPatients, rooms, sources, closed, courses, schedule, roomLoads, bookedInPeriod] =
    await Promise.all([
    prisma.appointment.findMany({
      where: { companyId, deletedAt: null, startAt: { gte: from, lt: to } },
      select: {
        id: true,
        startAt: true,
        durationMin: true,
        status: true,
        revenue: true,
        isPaid: true,
        isFirstVisit: true,
        courseId: true,
        sourceId: true,
        roomId: true,
        // Привязка визита к диалогу: по ней воронка считает, сколько
        // обращений в переписке дошло до записи.
        conversationId: true,
        staffId: true,
        staff: { select: { name: true, specialty: true } },
        room: { select: { id: true, name: true, sortOrder: true } },
        primaryService: { select: { title: true, kind: true } },
        patient: { select: { name: true } },
      },
      orderBy: { startAt: "asc" },
    }),
    /**
     * Обращения — по правилу 24 часов (§8), а не по числу начатых диалогов.
     * Постоянная пациентка, пишущая каждый месяц в один и тот же чат,
     * засчитывалась один раз — в месяц первого сообщения.
     */
    countInquiriesFromDb(companyId, from, to),
    /**
     * Новые пациенты — только те, чью дату первого обращения мы действительно
     * знаем. У клиента, перенесённого из YCLIENTS без визитов, её взять
     * неоткуда, и в дату попадает день переноса: без этого условия вся старая
     * база разом становилась притоком августа — 514 карточек в один день.
     */
    prisma.patient.count({
      where: {
        companyId,
        deletedAt: null,
        firstSeenExact: true,
        firstSeenAt: { gte: from, lt: to },
      },
    }),
    prisma.room.findMany({
      where: { companyId, isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true },
    }),
    prisma.source.findMany({
      where: { companyId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, code: true, title: true },
    }),
    closedDatesBetween(companyId, from, to),
    prisma.course.count({ where: { companyId } }),
    loadSchedule(companyId),
    roomOccupancyBetween(companyId, from, to),
    prisma.appointment.count({
      where: {
        companyId,
        deletedAt: null,
        status: { not: "CANCELLED" },
        createdAtYclients: { gte: from, lt: to },
      },
    }),
  ]);

  const booked = appts.filter((a) => a.status !== "CANCELLED");
  const roomOccupancy = new Map(roomLoads.map((r) => [r.roomId, r.rate]));
  const arrived = appts.filter((a) => a.status === "ARRIVED");
  const revenue = arrived.reduce((sum, a) => sum + Number(a.revenue), 0);
  /**
   * Отдельной «оплаченной выручки» больше нет — решение заказчика.
   *
   * Выручка визита — стоимость оказанной услуги: пришёл на приём за 8000 ₽,
   * значит 8000 ₽ и есть выручка. Отметка оплаты в YCLIENTS у этой клиники
   * стоит на всех записях подряд (значение 1 у всех пятидесяти в проверке),
   * то есть различать по ней нечего, а вторая цифра рядом с первой только
   * заставляла бы гадать, какая из них настоящая.
   */
  const courseRevenue = arrived
    .filter((a) => a.courseId)
    .reduce((sum, a) => sum + Number(a.revenue), 0);

  /**
   * Курсы, проданные в периоде: их деньги — выручка дней покупки (§8).
   *
   * Курс пробивают кассой, а не приёмом. Без этих сумм выручка занижена ровно
   * на то, что клиника заработала на курсах, а специалист, который их ведёт,
   * выглядит бесполезным.
   */
  const coursesSold = await prisma.course.findMany({
    where: { companyId, purchasedAt: { gte: from, lt: to } },
    select: { amount: true, appointments: { select: { staffId: true } } },
  });
  const coursesAmount = coursesSold.reduce((sum, c) => sum + Number(c.amount), 0);

  /**
   * Воронка. Числа полные: обращения в переписке, все записи клиники и все
   * состоявшиеся визиты — владельцу нужна вся статистика, а не только та
   * часть, что пришла из мессенджеров.
   *
   * Из-за этого шаги считаются по разным множествам: записаться можно по
   * телефону и прямо в YCLIENTS, не написав ни слова в переписке. Поэтому
   * конверсия между первым и вторым шагом бывает больше ста процентов — и в
   * этом случае она не показывается вовсе (см. buildFunnel). Число «записались
   * 51» верное, а «2550% от обращений» — нет.
   *
   * Сколько записей пришло именно из переписки, видно отдельной строкой: у
   * визита есть привязка к диалогу.
   */
  const fromDialog = booked.filter((a) => a.conversationId !== null);
  const funnel = {
    inquiries: inquiries.total,
    booked: booked.length,
    arrived: arrived.length,
  };

  // Первичные и повторные — по §8. Визит внутри курса отделяем: это не
  // «пациент вернулся», а «идёт по программе».
  const first = arrived.filter((a) => a.isFirstVisit).length;
  const courseSession = arrived.filter((a) => !a.isFirstVisit && a.courseId).length;

  /**
   * Деньги за курсы — тому, кто их ведёт.
   *
   * Без этого БОС-терапевт выглядела так: пятьдесят девять приёмов и четыре
   * тысячи выручки. Её приёмы — сеансы курсов, каждый по нулю, а деньги за
   * курсы лежат в продажах, и продажа специалиста не знает: у кассовой
   * операции есть клиент и сумма, но не врач.
   *
   * Специалиста берём у сеансов самого курса — их ведёт один человек. Курс,
   * по которому сеансов ещё не было, остаётся без специалиста: в общей
   * выручке он есть, в разрезе по людям — нет, и выдумывать тут нечего.
   */
  const courseByStaff = new Map<string, { amount: number; count: number }>();
  for (const c of coursesSold) {
    const staffIds = c.appointments.map((a) => a.staffId);
    const top = staffIds.sort(
      (a, b) =>
        staffIds.filter((x) => x === b).length - staffIds.filter((x) => x === a).length,
    )[0];
    if (!top) continue;
    const acc = courseByStaff.get(top) ?? { amount: 0, count: 0 };
    acc.amount += Number(c.amount);
    acc.count += 1;
    courseByStaff.set(top, acc);
  }

  const staffStats: StaffStat[] = [...groupBy(arrived, (a) => a.staffId)].map(([staffId, list]) => {
    const rev =
      list.reduce((sum, a) => sum + Number(a.revenue), 0) +
      (courseByStaff.get(staffId)?.amount ?? 0);
    return {
      staffId,
      name: list[0].staff?.name ?? "—",
      specialty: list[0].staff?.specialty ?? "",
      appointments: list.length,
      revenue: rev,
      /**
       * Чек здесь считать незачем: `withStaffShares` пересчитывает его сам —
       * выручка ÷ приёмы. Своё значение отсюда всё равно затиралось, и в коде
       * стояли два определения одного числа. Ноль — не данные, а заглушка.
       */
      avgCheck: 0,
      appointmentsShare: 0,
      revenueShare: 0,
    };
  });

  const sourceStats: SourceStat[] = sources.map((s) => ({
    code: s.code,
    title: s.title,
    inquiries: inquiries.bySource.get(s.id) ?? 0,
    booked: booked.filter((a) => a.sourceId === s.id).length,
    share: 0,
  }));

  /**
   * Записи, у которых источник не проставлен.
   *
   * Разрез строился по справочнику источников, и всё, что мимо него, не
   * попадало ни в одну строку. Из YCLIENTS источник не приходит вовсе, значит
   * почти каждая запись клиники была невидима: разрез показывал нули и
   * выглядел сломанным, хотя записи есть. Та же болезнь, что была у услуг.
   */
  const withoutSource = booked.filter((a) => a.sourceId === null).length;
  if (withoutSource > 0) {
    sourceStats.push({
      code: "none",
      title: "Источник не указан",
      inquiries: 0,
      booked: withoutSource,
      share: 0,
    });
  }

  return {
    period: {
      key: period,
      label: periodLabel(period),
      from: from.toISOString(),
      to: to.toISOString(),
      /**
       * Рабочих дней в периоде. Для скользящего окна — до сегодня; для
       * календарного месяца — весь месяц, иначе средние за май считались бы
       * по неполному месяцу.
       */
      workingDays: Math.max(1, workingDaysBetween(from, denominatorEnd(period, from, to, now), closed)),
      // Пустой график означает запасные двенадцать часов в день, и тогда все
      // доли загрузки занижены — это должно быть видно на экране.
      scheduleFilled: schedule.size > 0,
    },
    funnel,
    funnelSteps: buildFunnel(funnel),
    /**
     * Записи, СОЗДАННЫЕ в периоде (§8), — рядом с записями, приходящимися на
     * период. Это разные вопросы: «сколько человек записалось в августе» и
     * «сколько приёмов в августе». Для отдачи рекламы важен первый, для
     * загрузки клиники — второй, и подменять одно другим нельзя.
     */
    bookedInPeriod,
    /** Сколько записей и визитов пришло из переписки — атрибуция §8. */
    fromDialog: {
      booked: fromDialog.length,
      arrived: fromDialog.filter((a) => a.status === "ARRIVED").length,
    },
    money: {
      // Выручка периода: приёмы плюс проданные курсы (§8).
      revenue: revenue + coursesAmount,
      courseRevenue,
      /**
       * Средний чек — выручка ÷ приёмы, одним правилом везде.
       *
       * Выручка включает проданные курсы, значит и чек включает: деньги за
       * курс заработаны его сеансами, а сеансы — это приёмы. Считать чек по
       * одному определению в итогах и по другому у специалистов значит завести
       * две правды об одном числе (§8).
       */
      avgCheck: averageCheck(revenue + coursesAmount, arrived.length),
      newPatients,
      coursesSold: coursesSold.length,
      coursesAmount,
    },
    /**
     * Ведутся ли курсы вообще.
     *
     * Разрез «повторные — курсовые и возвраты» имеет смысл, только если курсы
     * в системе есть. Раньше их не заводил никто, и «Курсовые 0» стояло
     * всегда — структурный ноль, неотличимый от данных. Теперь курсы
     * собираются из кассовых продаж, и ноль здесь снова что-то значит: у
     * клиники не отмечено ни одной курсовой услуги.
     */
    coursesTracked: courses > 0,
    visitMix: {
      first,
      courseSession,
      returned: arrived.length - first - courseSession,
      total: arrived.length,
    },
    rooms: buildRoomDays(rooms, booked, from, to, closed, schedule, roomOccupancy),
    sources: withSourceShares(sourceStats),
    staff: withStaffShares(staffStats).sort((a, b) => b.revenue - a.revenue),
    updatedAt: now.toISOString(),
  };
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}

/** Визит в том виде, в каком он нужен полосе кабинетов. */
interface ApptRow {
  id: string;
  startAt: Date;
  durationMin: number;
  roomId: string | null;
  courseId: string | null;
  staff: { name: string; specialty: string | null } | null;
  primaryService: { title: string; kind: string } | null;
  patient: { name: string | null } | null;
}

/**
 * Полоса дня по кабинетам. Показываем последний день с визитами, а не
 * сегодняшний: если сегодня выходной или день ещё не начался, пустая полоса
 * выглядит как поломка.
 */
function buildRoomDays(
  rooms: { id: string; name: string }[],
  appts: ApptRow[],
  from: Date,
  to: Date,
  closed: Set<string>,
  schedule: Schedule,
  /**
   * Загрузка за период — из общей функции, а не своя.
   *
   * Здесь она считалась по всем неотменённым визитам, включая неявки, а
   * roomOccupancyBetween неявки исключает: пациент не пришёл, кабинет был
   * свободен. На одном и том же периоде выходило 23% против 21%. Разница
   * небольшая, но это ровно тот случай, когда две функции считают одно и то же
   * и расходятся — а владелец видит две цифры и не знает, какой верить.
   */
  occupancy: Map<string, number>,
): RoomDay[] {
  const days = appts.map((a) => isoDate(a.startAt));
  const shownDate = days.length > 0 ? days[days.length - 1] : isoDate(to);
  // Рабочие минуты периода по графику клиники, а не «двенадцать часов на день».
  const periodMinutes = Math.max(1, workingMinutesBetween(from, to, schedule, closed));
  // Окно показываемого дня — по его дню недели: в субботу клиника открывается
  // позже, и полоса должна начинаться там же, где начинается работа.
  const shownDay = dayInterval(schedule, new Date(`${shownDate}T12:00:00Z`)) ?? FALLBACK_DAY;
  const shownMinutes = shownDay.endMinute - shownDay.startMinute;

  return rooms.map((room) => {
    const ofRoom = appts.filter((a) => a.roomId === room.id);
    const ofDay = ofRoom.filter((a) => isoDate(a.startAt) === shownDate);

    const intervals: RoomInterval[] = ofDay.map((a) => {
      const start = minuteOfDay(a.startAt);
      return {
        appointmentId: a.id,
        startMinute: start,
        endMinute: start + a.durationMin,
        serviceTitle: a.primaryService?.title ?? "Приём",
        serviceKind: (a.primaryService?.kind ?? "OTHER") as RoomInterval["serviceKind"],
        staffName: a.staff?.name ?? "—",
        patientLabel: a.patient?.name ?? "—",
        isCourseSession: Boolean(a.courseId),
      };
    });

    const busy = busyMinutes(intervals, shownDay);

    return {
      roomId: room.id,
      roomName: room.name,
      date: shownDate,
      openMinute: shownDay.startMinute,
      closeMinute: shownDay.endMinute,
      intervals,
      gaps: freeGaps(intervals, shownDay, 60),
      busyMinutes: busy,
      workingMinutes: shownMinutes,
      occupancy: occupancyRate(busy, shownMinutes),
      periodOccupancy: occupancy.get(room.id) ?? 0,
    };
  });
}

/**
 * Загрузка по услугам: занятые минуты к доступным минутам тех кабинетов, где
 * услуга проводится. Раньше считалась по вымышленным средним за день.
 */
export interface RoomOccupancyRow {
  roomId: string;
  name: string;
  busyMinutes: number;
  availableMinutes: number;
  /** Доля занятого времени, 0…1. */
  rate: number;
}

/**
 * Загрузка кабинетов за произвольный период — одна функция на всю платформу.
 *
 * Раньше кабинет владельца считал загрузку сам: по зашитому списку «Кабинет
 * 1/2/3», по зашитому дню 9:00–21:00 и по сегодняшним визитам, причём визит без
 * кабинета попадал в первый кабинет. Отчёты считали иначе — по настоящим
 * кабинетам и графику клиники. На двух экранах выходили разные числа под
 * одинаковой подписью: 8% против 0%. Владельцу невозможно объяснить, какому
 * верить, и правильный ответ — «никакому»: расхождение само по себе ошибка.
 */
export async function roomOccupancyBetween(
  companyId: string,
  from: Date,
  to: Date,
): Promise<RoomOccupancyRow[]> {
  const [rooms, appts, closed, schedule] = await Promise.all([
    prisma.room.findMany({
      where: { companyId, isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true },
    }),
    prisma.appointment.findMany({
      where: {
        companyId,
        deletedAt: null,
        // Отменённые и неявки время кабинета не занимают: слот освобождается.
        status: { in: ["CREATED", "CONFIRMED", "ARRIVED"] },
        startAt: { gte: from, lt: to },
      },
      select: { roomId: true, durationMin: true },
    }),
    closedDatesBetween(companyId, from, to),
    loadSchedule(companyId),
  ]);

  const available = Math.max(1, workingMinutesBetween(from, to, schedule, closed));

  return rooms.map((room) => {
    // Визиты без кабинета не приписываем никакому: они видны отдельной
    // строкой в проверке состояния, а тихо раздувать первый кабинет нельзя.
    const busy = appts
      .filter((a) => a.roomId === room.id)
      .reduce((sum, a) => sum + a.durationMin, 0);
    return {
      roomId: room.id,
      name: room.name,
      busyMinutes: busy,
      availableMinutes: available,
      rate: Math.min(busy / available, 1),
    };
  });
}

export interface ServiceLoadRow {
  title: string;
  ratio: number;
  busyMinutes: number;
  availableMinutes: number;
  /** Приёмов за период — по ним и считается занятое время. */
  appointments: number;
  /**
   * Услуга выключена в справочнике, но приёмы по ней были.
   *
   * Такая строка раньше пропадала из отчёта целиком вместе со своими часами:
   * читались только включённые услуги. Прятать работу, которая была,
   * нельзя — по этому разрезу решают, чем занята клиника.
   */
  inactive: boolean;
}

export async function getServicesLoadDb(
  companyId: string,
  period: PeriodKey,
): Promise<ServiceLoadRow[]> {
  // Те же границы, что и в основном отчёте — иначе разрезы разъедутся.
  const now = new Date();
  const { from, to } = periodBounds(period, now);
  /**
   * Рабочие минуты — по графику клиники, той же функцией, что и загрузка
   * кабинетов. Прежде здесь стоял зашитый двенадцатичасовой день, и два
   * разреза одного отчёта считали доступное время по-разному.
   */
  const [closedDates, schedule] = await Promise.all([
    closedDatesBetween(companyId, from, to),
    loadSchedule(companyId),
  ]);
  const minutesPerRoom = Math.max(
    1,
    workingMinutesBetween(from, denominatorEnd(period, from, to, now), schedule, closedDates),
  );

  /**
   * Считаем от ПРИЁМОВ, а не от справочника.
   *
   * Раньше отчёт брал включённые услуги и складывал их приёмы через связь. У
   * клиники «Остеопатия, приём Ирины» показывала ноль минут при тысячах
   * визитов: приёмы держатся за ту строку справочника, на которую ссылаются
   * сами записи, а в отчёт попадала другая — заведённая руками или оставшаяся
   * включённой. Работа, которая была, пропадала с экрана.
   *
   * Теперь основа — приёмы периода. Услуга к ним приклеивается, а не наоборот:
   * ни выключенная строка, ни задвоенная больше не прячут часы.
   */
  /**
   * Считаем по ВСЕМ услугам визита, а не по первой.
   *
   * Визит помнил только основную услугу, и запись из двух услуг теряла вторую
   * целиком: услуга, которая всегда идёт второй, показывала ноль приёмов
   * навсегда — при том что её делают каждый день.
   *
   * Состав визита теперь пишет выгрузка. Пока он записан не у всех визитов
   * (старые данные до первой полной выгрузки), опираемся на основную услугу —
   * иначе разрез опустел бы на время перехода.
   */
  const [appts, allServices, roomCount] = await Promise.all([
    prisma.appointment.findMany({
      where: { companyId, deletedAt: null, status: { not: "CANCELLED" }, startAt: { gte: from, lt: to } },
      select: {
        durationMin: true,
        primaryServiceId: true,
        services: { select: { serviceId: true, durationMin: true } },
      },
    }),
    prisma.service.findMany({
      where: { companyId },
      select: { id: true, title: true, isActive: true, rooms: { select: { roomId: true } } },
    }),
    prisma.room.count({ where: { companyId } }),
  ]);

  /** Занятые минуты и число приёмов по каждой услуге. */
  const busyById = new Map<string, { minutes: number; count: number }>();
  let orphanCount = 0;
  let orphanMinutes = 0;

  for (const a of appts) {
    const parts = a.services.length > 0
      ? a.services
      : a.primaryServiceId
        ? [{ serviceId: a.primaryServiceId, durationMin: a.durationMin }]
        : [];
    if (parts.length === 0) {
      orphanCount += 1;
      orphanMinutes += a.durationMin;
      continue;
    }

    /**
     * Время визита делим между его услугами пропорционально их длительности.
     * Так сумма часов по услугам сходится с занятым временем кабинета: два
     * разреза одного периода не должны давать разные итоги.
     */
    const total = parts.reduce((sum, p) => sum + p.durationMin, 0);
    for (const p of parts) {
      const share = total > 0 ? p.durationMin / total : 1 / parts.length;
      const acc = busyById.get(p.serviceId) ?? { minutes: 0, count: 0 };
      acc.minutes += a.durationMin * share;
      acc.count += 1;
      busyById.set(p.serviceId, acc);
    }
  }

  /**
   * В отчёт идут услуги с приёмами и включённые без приёмов. Выключенная и без
   * приёмов не нужна никому: она только удлиняет список.
   */
  const shown = allServices.filter((s) => s.isActive || (busyById.get(s.id)?.count ?? 0) > 0);

  const rows: ServiceLoadRow[] = shown.map((s) => {
    const stat = busyById.get(s.id);
    const busy = Math.round(stat?.minutes ?? 0);

    /**
     * Знаменатель — минуты кабинетов, где услуга может проводиться.
     *
     * Привязка «услуга → кабинет» заводится вручную, и у услуг, приехавших
     * из YCLIENTS, её нет. Без привязки считаем, что услуга может идти в
     * любом кабинете клиники: это приблизительно, но отвечает на вопрос
     * «чем занят день», а ноль не отвечает ни на что.
     */
    const roomsForService = s.rooms.length > 0 ? s.rooms.length : roomCount;
    const available = roomsForService * minutesPerRoom;
    return {
      title: s.title,
      busyMinutes: busy,
      availableMinutes: available,
      ratio: available > 0 ? busy / available : 0,
      appointments: stat?.count ?? 0,
      inactive: !s.isActive,
    };
  });

  /**
   * Приёмы, у которых услуга не указана вовсе.
   *
   * Их не видно ни одной строкой, и сумма разреза молча не сходится с числом
   * приёмов за период. Показываем отдельной строкой: пустое место объяснимо,
   * а расхождение — нет.
   */
  if (orphanCount > 0) {
    rows.push({
      title: "Без указанной услуги",
      busyMinutes: orphanMinutes,
      availableMinutes: roomCount * minutesPerRoom,
      ratio: 0,
      appointments: orphanCount,
      inactive: false,
    });
  }

  return rows
    /**
     * Сортируем по занятому времени, а не по доле.
     *
     * Доля зависит от числа кабинетов и при их отсутствии у всех одинакова.
     * Занятые минуты — то, что администратор и хочет видеть: чем клиника
     * занята больше всего.
     */
    .sort((a, b) => b.busyMinutes - a.busyMinutes || b.ratio - a.ratio);
}
