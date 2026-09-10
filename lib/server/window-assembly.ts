import { prisma } from "@/lib/db";
import { startOfClinicDay } from "@/lib/clinic-time";
import { clinicDayFor } from "@/lib/server/clinic-day";
import { getCallbackQueue } from "@/lib/server/callback-queue";
import {
  assembleWindow,
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
): Promise<AssemblySuggestion[]> {
  const date = new Date(input.dayIso);
  if (Number.isNaN(date.getTime())) return [];
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
        staff: { select: { name: true, workdays: true } },
        patient: { select: { name: true } },
      },
    }),
    prisma.room.findMany({ where: { companyId }, select: { id: true, name: true } }),
    getCallbackQueue(companyId),
    prisma.serviceRoom.findMany({ where: { companyId }, select: { serviceId: true, roomId: true } }),
  ]);

  // Клиника в этот день не работает — собирать нечего.
  if (!window) return [];

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
   * Дни приёма живут у сотрудника (`Staff.workdays`), а часов смены у нас нет
   * — их клиника не заводила. Поэтому смена = рабочие часы клиники в тот
   * день, но ТОЛЬКО если это его рабочий день; пустой список дней означает
   * «не заполнено», и тогда мы не предлагаем ничего: догадка о чужом графике
   * стоит человеку зря потраченного дня.
   */
  const weekday = ((day.getDay() + 6) % 7) + 1;
  const staffShift: Record<string, { startMinute: number; endMinute: number } | null> = {};
  for (const a of appts) {
    const days = a.staff?.workdays ?? [];
    staffShift[a.staffId] = days.length === 0 ? null : days.includes(weekday) ? window : null;
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

  const moves: Move[] = assembleWindow(bookings, ctx, now);
  const staffName = new Map(appts.map((a) => [a.staffId, a.staff?.name ?? null]));

  return moves.map((m) => ({
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
}
