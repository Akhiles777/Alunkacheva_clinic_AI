import { prisma } from "@/lib/db";
import { startOfClinicDay } from "@/lib/clinic-time";
import { getCallbackQueue } from "@/lib/server/callback-queue";
import {
  fitsWindow,
  minutesUntil,
  windowIsPast,
  TIGHT_MINUTES,
  type CandidateInput,
  type WindowSlot,
} from "@/lib/metrics/window-fit";

/**
 * Кого позвать в свободное окно.
 *
 * Кандидатов берём из очереди «Кому позвонить» — той же самой, не заводя
 * второго списка: иначе на одном экране человек «выпал из курса», а на другом
 * его нет, и обе строки одинаково не заслуживают доверия.
 *
 * Проверки живут в `lib/metrics/window-fit.ts` и проверены тестами. Здесь
 * только сбор фактов: длительность услуги, кабинеты услуги, занятость
 * специалиста и самого пациента.
 */

export interface WindowCandidate {
  patientId: string;
  patientName: string;
  basis: string;
  serviceTitle: string | null;
  serviceDurationMin: number | null;
  money: number | null;
  /** Куда писать. Пусто — в кандидаты не попал бы, но пусть будет явно. */
  dialogId: string | null;
}

export interface WindowOffer {
  candidates: WindowCandidate[];
  /** Времени до окна мало: договориться могут не успеть. */
  tight: boolean;
  /** Окно уже занято или прошло — кандидатов не показываем вовсе. */
  gone: boolean;
  /** Сколько кандидатов очереди не подошло и почему — числом, без имён. */
  skipped: { long: number; room: number; staff: number; unreachable: number; busy: number; unknownService: number };
}

/**
 * Свободно ли окно прямо сейчас.
 *
 * Отдельной проверкой и на каждое действие: пока администратор смотрел на
 * список, окно мог занять кто-то другой — в том числе второй администратор.
 * Предложить туда пациента после этого значит подставить обоих.
 */
export async function windowStillFree(
  companyId: string,
  roomId: string,
  startAt: Date,
  durationMin: number,
): Promise<boolean> {
  const end = new Date(startAt.getTime() + durationMin * 60_000);
  const clash = await prisma.appointment.findFirst({
    where: {
      companyId,
      deletedAt: null,
      roomId,
      status: { notIn: ["CANCELLED"] },
      startAt: { lt: end },
      endAt: { gt: startAt },
    },
    select: { id: true },
  });
  return clash === null;
}

export async function windowCandidates(
  companyId: string,
  input: { roomId: string; startAtIso: string; durationMin: number },
): Promise<WindowOffer> {
  const startAt = new Date(input.startAtIso);
  const empty: WindowOffer = {
    candidates: [],
    tight: false,
    gone: true,
    skipped: { long: 0, room: 0, staff: 0, unreachable: 0, busy: 0, unknownService: 0 },
  };
  if (Number.isNaN(startAt.getTime())) return empty;

  const day = startOfClinicDay(startAt);
  const slot: WindowSlot = {
    startMinute: Math.round((startAt.getTime() - day.getTime()) / 60_000),
    durationMin: input.durationMin,
    roomId: input.roomId,
    date: day,
  };
  if (windowIsPast(slot)) return empty;
  if (!(await windowStillFree(companyId, input.roomId, startAt, input.durationMin))) return empty;

  const queue = await getCallbackQueue(companyId);
  if (queue.rows.length === 0) {
    return { ...empty, gone: false };
  }

  const patientIds = queue.rows.map((r) => r.patientId);
  const end = new Date(startAt.getTime() + input.durationMin * 60_000);

  const [lastVisits, courses, dialogs, phones, busy, roomsByService] = await Promise.all([
    /** Что человек брал в последний раз — это и предлагаем. */
    prisma.appointment.findMany({
      where: {
        companyId,
        deletedAt: null,
        patientId: { in: patientIds },
        status: { in: ["ARRIVED", "NO_SHOW"] },
      },
      orderBy: { startAt: "desc" },
      select: { patientId: true, primaryServiceId: true, startAt: true },
    }),
    prisma.course.findMany({
      where: { companyId, patientId: { in: patientIds } },
      select: { id: true, patientId: true, serviceId: true },
    }),
    prisma.conversation.findMany({
      where: { companyId, deletedAt: null, isPractice: false, patientId: { in: patientIds } },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true, patientId: true },
    }),
    prisma.patientPhone.findMany({
      where: { companyId, patientId: { in: patientIds } },
      select: { patientId: true },
    }),
    /** Своя запись пациента, пересекающаяся с окном. */
    prisma.appointment.findMany({
      where: {
        companyId,
        deletedAt: null,
        patientId: { in: patientIds },
        status: { notIn: ["CANCELLED"] },
        startAt: { lt: end },
        endAt: { gt: startAt },
      },
      select: { patientId: true },
    }),
    prisma.serviceRoom.findMany({
      where: { companyId },
      select: { serviceId: true, roomId: true },
    }),
  ]);

  const lastServiceOf = new Map<string, string>();
  for (const v of lastVisits) {
    if (!lastServiceOf.has(v.patientId) && v.primaryServiceId) {
      lastServiceOf.set(v.patientId, v.primaryServiceId);
    }
  }
  const courseServiceOf = new Map<string, string>();
  for (const c of courses) courseServiceOf.set(c.id, c.serviceId);

  const dialogOf = new Map<string, string>();
  for (const d of dialogs) if (d.patientId && !dialogOf.has(d.patientId)) dialogOf.set(d.patientId, d.id);
  const hasPhone = new Set(phones.map((p) => p.patientId));
  const busyIds = new Set(busy.map((b) => b.patientId));

  const rooms = new Map<string, string[]>();
  for (const r of roomsByService) {
    rooms.set(r.serviceId, [...(rooms.get(r.serviceId) ?? []), r.roomId]);
  }

  const serviceIds = [
    ...new Set([...lastServiceOf.values(), ...courseServiceOf.values()].filter(Boolean)),
  ];
  const services = await prisma.service.findMany({
    where: { companyId, id: { in: serviceIds } },
    select: { id: true, title: true, durationMin: true },
  });
  const serviceById = new Map(services.map((s) => [s.id, s]));

  /**
   * Кто ведёт услугу — из визитов, а не из настройки.
   *
   * Отдельной таблицы «специалист → услуга» в системе нет намеренно: кто что
   * ведёт, уже записано в визитах, и вторая правда об этом однажды разойдётся
   * с первой (так же это решает ассистент).
   */
  const staffOfService = new Map<string, string[]>();
  if (serviceIds.length > 0) {
    const links = await prisma.appointmentService.findMany({
      where: { companyId, serviceId: { in: serviceIds } },
      select: { serviceId: true, appointment: { select: { staffId: true } } },
      take: 2000,
    });
    for (const l of links) {
      const cur = staffOfService.get(l.serviceId) ?? [];
      if (!cur.includes(l.appointment.staffId)) cur.push(l.appointment.staffId);
      staffOfService.set(l.serviceId, cur);
    }
  }

  /**
   * Свободен ли специалист услуги в это время. Считаем по его записям: если у
   * КАЖДОГО, кто ведёт услугу, в это время занято — предлагать некому.
   * Специалисты услуги не заданы — ограничения нет, решает администратор.
   */
  const staffIds = [...new Set([...staffOfService.values()].flat())];
  const staffBusy = staffIds.length
    ? await prisma.appointment.findMany({
        where: {
          companyId,
          deletedAt: null,
          staffId: { in: staffIds },
          status: { notIn: ["CANCELLED"] },
          startAt: { lt: end },
          endAt: { gt: startAt },
        },
        select: { staffId: true },
      })
    : [];
  const staffBusyIds = new Set(staffBusy.map((s) => s.staffId));

  const skipped = { long: 0, room: 0, staff: 0, unreachable: 0, busy: 0, unknownService: 0 };
  const candidates: WindowCandidate[] = [];

  for (const row of queue.rows) {
    const serviceId =
      (row.courseId ? courseServiceOf.get(row.courseId) : null) ??
      lastServiceOf.get(row.patientId) ??
      null;
    const service = serviceId ? serviceById.get(serviceId) : undefined;
    const linked = serviceId ? (staffOfService.get(serviceId) ?? []) : [];

    const input: CandidateInput = {
      patientId: row.patientId,
      patientName: row.patientName,
      basis: row.basis,
      serviceId: serviceId,
      serviceTitle: service?.title ?? null,
      serviceDurationMin: service?.durationMin ?? null,
      serviceRoomIds: serviceId ? (rooms.get(serviceId) ?? []) : [],
      staffAvailable: linked.length === 0 ? null : linked.some((id) => !staffBusyIds.has(id)),
      reachable: dialogOf.has(row.patientId) || hasPhone.has(row.patientId),
      busyAtWindow: busyIds.has(row.patientId),
      money: row.money,
    };

    const fit = fitsWindow(input, slot);
    if (!fit.ok) {
      if (fit.reason) skipped[fit.reason] += 1;
      continue;
    }
    candidates.push({
      patientId: row.patientId,
      patientName: row.patientName,
      basis: row.basis,
      serviceTitle: input.serviceTitle,
      serviceDurationMin: input.serviceDurationMin,
      money: row.money,
      dialogId: dialogOf.get(row.patientId) ?? null,
    });
  }

  return {
    candidates: candidates.slice(0, 8),
    tight: minutesUntil(slot) < TIGHT_MINUTES,
    gone: false,
    skipped,
  };
}
