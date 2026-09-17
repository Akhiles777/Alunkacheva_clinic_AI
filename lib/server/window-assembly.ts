import { prisma } from "@/lib/db";
import { startOfClinicDay } from "@/lib/clinic-time";
import { freeGaps } from "@/lib/metrics/occupancy";
import { clinicDayFor } from "@/lib/server/clinic-day";
import { getCallbackQueue } from "@/lib/server/callback-queue";
import {
  assembleWindow,
  blockerFor,
  type Blocker,
  type AssemblyContext,
  type Booking,
  type Move,
} from "@/lib/metrics/window-assembly";

/**
 * Собрать окно под длинную услугу — сбор фактов из базы.
 *
 * Правила и все проверки безопасности переноса — в
 * `lib/metrics/window-assembly.ts`, там же тесты. Здесь только чтение:
 * занятость кабинета и специалистов, смены, рабочие часы клиники, кто ходит
 * регулярно и кому и так собираются звонить.
 *
 * Данные о расписании перечитываются в момент запроса: между показом и
 * действием проходят минуты, а за минуту появляется чужая запись.
 */

/**
 * Что показать, когда предложить нечего.
 *
 * «Собрать не получится» на все случаи сразу — это и есть «функция не
 * работает»: администратор не знает, ждать ли ему другого дня, звонить самому
 * или заполнить настройку.
 */
export interface AssemblyResult {
  rows: AssemblySuggestion[];
  /** Почему предложить нечего — словами. Заполнено только при пустом `rows`. */
  note: string | null;
}

export interface AssemblySuggestion {
  bookingId: string;
  patientName: string;
  serviceTitle: string;
  /** Было и стало — словами администратора. */
  fromTime: string;
  toTime: string;
  shiftMin: number;
  /** Какое окно получится. */
  freedFrom: string;
  freedTo: string;
  freedMin: number;
  staffName: string | null;
  roomName: string | null;
}

const TIME = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

function hhmm(day: Date, minute: number): string {
  return TIME.format(new Date(day.getTime() + minute * 60_000));
}

/**
 * Что предложить, если окна на нужную длительность нет.
 *
 * Возвращает не больше трёх предложений, каждое — ОДИН перенос. Цепочки из
 * двух не строим: договариваться пришлось бы с двумя людьми, и вероятность,
 * что всё сложится, падает вдвое.
 */
export async function suggestAssembly(
  companyId: string,
  input: { roomId: string; dayIso: string; needMin: number },
): Promise<AssemblyResult> {
  const date = new Date(input.dayIso);
  if (Number.isNaN(date.getTime())) return { rows: [], note: "День выбран неверно." };
  const day = startOfClinicDay(date);
  const dayEnd = new Date(day.getTime() + 24 * 3600 * 1000);

  const [{ window }, appts, rooms, queue, serviceRooms] = await Promise.all([
    clinicDayFor(companyId, day),
    prisma.appointment.findMany({
      where: {
        companyId,
        deletedAt: null,
        startAt: { gte: day, lt: dayEnd },
        status: { notIn: ["CANCELLED"] },
      },
      select: {
        id: true,
        patientId: true,
        staffId: true,
        roomId: true,
        startAt: true,
        endAt: true,
        durationMin: true,
        isFirstVisit: true,
        courseId: true,
        primaryServiceId: true,
        primaryService: { select: { title: true } },
        staff: { select: { name: true } },
        patient: { select: { name: true } },
      },
    }),
    prisma.room.findMany({ where: { companyId }, select: { id: true, name: true } }),
    getCallbackQueue(companyId),
    prisma.serviceRoom.findMany({ where: { companyId }, select: { serviceId: true, roomId: true } }),
  ]);

  // Клиника в этот день не работает — собирать нечего.
  if (!window) return { rows: [], note: "В этот день клиника не работает — собирать нечего." };

  const minuteOf = (at: Date) => Math.round((at.getTime() - day.getTime()) / 60_000);

  const roomBusy = appts
    .filter((a) => a.roomId === input.roomId)
    .map((a) => ({ id: a.id, startMinute: minuteOf(a.startAt), endMinute: minuteOf(a.endAt) }));

  const staffBusy: Record<string, { id: string; startMinute: number; endMinute: number }[]> = {};
  for (const a of appts) {
    const list = staffBusy[a.staffId] ?? [];
    list.push({ id: a.id, startMinute: minuteOf(a.startAt), endMinute: minuteOf(a.endAt) });
    staffBusy[a.staffId] = list;
  }

  /**
   * Смена специалиста.
   *
   * Часов смены у нас нет ни в каком виде — клиника их не заводила, — поэтому
   * границей служат рабочие часы клиники в этот день. Кто в этот день
   * принимает, берём из расписания, а не из настройки «дни приёма»: у
   * специалиста есть запись — значит он работает, и это факт, а не догадка.
   */
  const staffShift: Record<string, { startMinute: number; endMinute: number } | null> = {};
  for (const a of appts) {
    /**
     * У специалиста в этот день ЕСТЬ запись — значит он в этот день принимает.
     *
     * Здесь стояла проверка по `Staff.workdays`, и у клиники они не заполнены:
     * смена выходила `null`, двигать было некого, и панель на любой запрос
     * отвечала «собрать не получится». Со стороны это «функция не работает».
     *
     * Дни приёма — настройка, а запись в расписании — факт, и факт сильнее.
     * Часов смены у нас нет ни в каком виде, поэтому границей остаются рабочие
     * часы клиники: дальше них мы и так ничего не предлагаем.
     */
    staffShift[a.staffId] = window;
  }

  const rooms2 = new Map(rooms.map((r) => [r.id, r.name]));
  const serviceRoomMap: Record<string, string[]> = {};
  for (const sr of serviceRooms) {
    serviceRoomMap[sr.serviceId] = [...(serviceRoomMap[sr.serviceId] ?? []), sr.roomId];
  }

  /**
   * Кому и так собираются звонить — их не трогаем: два повода в одном разговоре
   * путают и администратора, и пациента.
   */
  const alreadyCalled = new Set(queue.rows.map((r) => r.patientId));

  /**
   * Регулярность: курс или больше одного состоявшегося визита. Человека,
   * который был один раз, просить подвинуться неловко и бесполезно.
   */
  const patientIds = [...new Set(appts.map((a) => a.patientId))];
  const visits = await prisma.appointment.groupBy({
    by: ["patientId"],
    where: { companyId, deletedAt: null, patientId: { in: patientIds }, status: "ARRIVED" },
    _count: { _all: true },
  });
  const visitCount = new Map(visits.map((v) => [v.patientId, v._count._all]));

  const now = new Date();
  const isToday = startOfClinicDay(now).getTime() === day.getTime();

  const bookings: Booking[] = appts.map((a) => ({
    id: a.id,
    patientId: a.patientId,
    patientName: a.patient?.name ?? "Пациент",
    staffId: a.staffId,
    roomId: a.roomId,
    serviceId: a.primaryServiceId,
    serviceTitle: a.primaryService?.title ?? "приём",
    startMinute: minuteOf(a.startAt),
    durationMin: a.durationMin,
    isFirstVisit: a.isFirstVisit,
    regular: Boolean(a.courseId) || (visitCount.get(a.patientId) ?? 0) > 1,
    date: day,
  }));

  const ctx: AssemblyContext = {
    roomId: input.roomId,
    needMin: input.needMin,
    day: window,
    roomBusy,
    staffBusy,
    staffShift,
    serviceRooms: serviceRoomMap,
    nowMinute: isToday ? Math.round((now.getTime() - day.getTime()) / 60_000) : null,
    alreadyCalled,
  };

  /**
   * Может быть, двигать вообще никого не надо.
   *
   * Панель предлагала «сдвинуть на пять минут» там, где нужное окно в кабинете
   * и так стояло свободным с утра: администратор читает это как бессмысленный
   * совет и перестаёт верить разделу. Сначала отвечаем на вопрос, который он
   * задал: где окно на столько минут.
   */
  const already = freeGaps(roomBusy, window, input.needMin).filter(
    (g) => g.durationMin >= input.needMin && (!isToday || g.endMinute > (ctx.nowMinute ?? 0)),
  );
  if (already.length > 0) {
    const g = already[0];
    return {
      rows: [],
      note:
        `Двигать никого не нужно: в кабинете уже свободно ${hhmm(day, g.startMinute)}–` +
        `${hhmm(day, g.endMinute)} (${g.durationMin} мин).`,
    };
  }

  const moves: Move[] = assembleWindow(bookings, ctx, now);
  const staffName = new Map(appts.map((a) => [a.staffId, a.staff?.name ?? null]));

  const rows = moves.map((m) => ({
    bookingId: m.booking.id,
    patientName: m.booking.patientName,
    serviceTitle: m.booking.serviceTitle,
    fromTime: hhmm(day, m.booking.startMinute),
    toTime: hhmm(day, m.toStartMinute),
    shiftMin: m.shiftMin,
    freedFrom: hhmm(day, m.freed.startMinute),
    freedTo: hhmm(day, m.freed.endMinute),
    freedMin: m.freed.endMinute - m.freed.startMinute,
    staffName: staffName.get(m.booking.staffId) ?? null,
    roomName: rooms2.get(input.roomId) ?? null,
  }));

  return { rows, note: rows.length > 0 ? null : explain(bookings, ctx, now) };
}

/**
 * Почему предложений нет. Считается по тем же правилам, что и сам подбор
 * (`blockerFor`), — второй список причин разошёлся бы с первым.
 */
function explain(bookings: Booking[], ctx: AssemblyContext, now: Date): string {
  const inRoom = bookings.filter((b) => b.roomId === ctx.roomId);
  if (inRoom.length === 0) {
    return "В этом кабинете в выбранный день записей нет — двигать нечего, окно и так свободно.";
  }
  const blockers = inRoom.map((b) => blockerFor(b, ctx, now));
  const free = blockers.filter((x) => x === null).length;
  if (free > 0) {
    return (
      `Подвинуть можно ${free} ${free === 1 ? "запись" : "записей"}, но ни один сдвиг до двух часов ` +
      "не собирает столько времени подряд: мешают соседние записи или смена специалиста. " +
      "Попробуйте меньшую длительность или другой день."
    );
  }
  const count = (kind: Blocker) => blockers.filter((x) => x === kind).length;
  const reasons: string[] = [];
  if (count("soon") > 0) {
    reasons.push(
      `${count("soon")} — на ближайшие сутки: так быстро с пациентом не договориться, ` +
        "попробуйте день через два и дальше",
    );
  }
  if (count("first") > 0) reasons.push(`${count("first")} — первичные, их не двигаем`);
  if (count("rare") > 0) {
    reasons.push(`${count("rare")} — у пациентов меньше двух состоявшихся визитов`);
  }
  if (count("called") > 0) reasons.push(`${count("called")} — этим людям и так собираются звонить`);
  return `Двигать некого: ${reasons.join("; ")}.`;
}
