import { prisma } from "@/lib/db";
import { buildFunnel } from "@/lib/metrics/funnel";
import { busyMinutes, freeGaps, occupancyRate, type Interval } from "@/lib/metrics/occupancy";
import { countInquiriesFromDb } from "@/lib/metrics/inquiries";
import { averageCheck, withSourceShares, withStaffShares } from "@/lib/metrics/summary";
import { closedDatesBetween } from "@/lib/server/clinic-day";
import { isMonthKey, monthBounds, monthLabel } from "@/lib/metrics/types";
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

const PERIOD_DAYS: Record<string, number> = { week: 7, month: 30, quarter: 90 };
const PERIOD_LABEL: Record<string, string> = {
  week: "Неделя",
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
  return {
    from: new Date(now.getTime() - (PERIOD_DAYS[period] ?? 30) * 24 * 3600 * 1000),
    to: endOfToday(now),
  };
}

/** Подпись периода для экрана. */
export function periodLabel(period: PeriodKey): string {
  return isMonthKey(period) ? monthLabel(period) : (PERIOD_LABEL[period] ?? period);
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
function dayInterval(schedule: Schedule, date: Date): Interval | null {
  if (schedule.size === 0) return FALLBACK_DAY;
  // В базе понедельник — 1, воскресенье — 7; в JS воскресенье — 0.
  const weekday = date.getDay() === 0 ? 7 : date.getDay();
  return schedule.get(weekday) ?? null;
}

/**
 * Рабочие минуты клиники за период — сумма по дням её собственного графика.
 * Закрытые даты (праздники) в знаменатель не идут: иначе кабинеты выглядят
 * простаивающими ровно на эти дни.
 */
function workingMinutesBetween(
  from: Date,
  to: Date,
  schedule: Schedule,
  closed?: Set<string>,
): number {
  let minutes = 0;
  const cursor = new Date(from);
  while (cursor < to) {
    const key = cursor.toISOString().slice(0, 10);
    const day = dayInterval(schedule, cursor);
    if (day && !closed?.has(key)) minutes += day.endMinute - day.startMinute;
    cursor.setDate(cursor.getDate() + 1);
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

/** Конец текущих суток в зоне клиники: граница отчётного окна. */
function endOfToday(now: Date): Date {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end;
}

/**
 * Рабочих дней в периоде: клиника не работает по воскресеньям и в дни, которые
 * отмечены исключением как закрытые (праздник, санитарный день).
 *
 * Без учёта исключений праздники попадали в знаменатель загрузки, и она
 * занижалась ровно на эти дни — кабинеты выглядели простаивающими, хотя
 * клиника была закрыта.
 */
function workingDaysBetween(from: Date, to: Date, closed?: Set<string>): number {
  let count = 0;
  const cursor = new Date(from);
  while (cursor < to) {
    const key = cursor.toISOString().slice(0, 10);
    if (cursor.getDay() !== 0 && !closed?.has(key)) count += 1;
    cursor.setDate(cursor.getDate() + 1);
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

  const [appts, inquiries, newPatients, rooms, sources, closed, schedule, bookedInPeriod] =
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
    loadSchedule(companyId),
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

  const staffStats: StaffStat[] = [...groupBy(arrived, (a) => a.staffId)].map(([staffId, list]) => {
    const rev = list.reduce((sum, a) => sum + Number(a.revenue), 0);
    return {
      staffId,
      name: list[0].staff?.name ?? "—",
      specialty: list[0].staff?.specialty ?? "",
      appointments: list.length,
      revenue: rev,
      avgCheck: averageCheck(rev, list.length),
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
      workingDays: Math.max(1, workingDaysBetween(from, isMonthKey(period) ? to : now, closed)),
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
      revenue,
      courseRevenue,
      avgCheck: averageCheck(revenue, arrived.length),
      newPatients,
      // Курсы считаются своей подсистемой; пока её нет, честнее показать ноль,
      // чем выдуманное число.
      coursesSold: 0,
      coursesAmount: 0,
    },
    visitMix: {
      first,
      courseSession,
      returned: arrived.length - first - courseSession,
      total: arrived.length,
    },
    rooms: buildRoomDays(rooms, booked, from, to, closed, schedule),
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
    const periodBusy = ofRoom.reduce((sum, a) => sum + a.durationMin, 0);

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
      periodOccupancy: occupancyRate(periodBusy, periodMinutes),
    };
  });
}

/**
 * Загрузка по услугам: занятые минуты к доступным минутам тех кабинетов, где
 * услуга проводится. Раньше считалась по вымышленным средним за день.
 */
export interface ServiceLoadRow {
  title: string;
  ratio: number;
  busyMinutes: number;
  availableMinutes: number;
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
    workingMinutesBetween(from, isMonthKey(period) ? to : now, schedule, closedDates),
  );

  const [services, roomCount] = await Promise.all([
    prisma.service.findMany({
      where: { companyId, isActive: true },
      select: {
        id: true,
        title: true,
        rooms: { select: { roomId: true } },
        primaryForAppointments: {
          where: { deletedAt: null, status: { not: "CANCELLED" }, startAt: { gte: from, lt: to } },
          select: { durationMin: true },
        },
      },
    }),
    prisma.room.count({ where: { companyId } }),
  ]);

  return services
    .map((s) => {
      const busy = s.primaryForAppointments.reduce((sum, a) => sum + a.durationMin, 0);

      /**
       * Знаменатель — минуты кабинетов, где услуга может проводиться.
       *
       * Привязка «услуга → кабинет» заводится вручную, и у услуг, приехавших
       * из YCLIENTS, её нет. Раньше это давало ноль в знаменателе, ноль в
       * доле — и весь отчёт по услугам выглядел пустым при полной базе
       * визитов. Без привязки считаем, что услуга может идти в любом кабинете
       * клиники: это приблизительно, но отвечает на вопрос «чем занят день», а
       * ноль не отвечает ни на что.
       */
      const roomsForService = s.rooms.length > 0 ? s.rooms.length : roomCount;
      const available = roomsForService * minutesPerRoom;
      return {
        title: s.title,
        busyMinutes: busy,
        availableMinutes: available,
        ratio: available > 0 ? busy / available : 0,
      };
    })
    /**
     * Сортируем по занятому времени, а не по доле.
     *
     * Доля зависит от числа кабинетов и при их отсутствии у всех одинакова.
     * Занятые минуты — то, что администратор и хочет видеть: чем клиника
     * занята больше всего.
     */
    .sort((a, b) => b.busyMinutes - a.busyMinutes || b.ratio - a.ratio);
}
