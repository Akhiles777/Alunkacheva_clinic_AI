import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

/**
 * Инструменты записи для агента: услуги, свободные окна, создание визита.
 *
 * Главное правило (§2): **слот перепроверяется перед самой записью**, внутри
 * транзакции и с блокировкой строк кабинета. Список свободных окон — это
 * витрина, а не разрешение: между показом слотов пациенту и его «да» проходят
 * минуты, за которые администратор мог записать туда же из YCLIENTS. Без
 * перепроверки получаются две записи в одно окно — худший исход для клиники.
 *
 * Локальные Appointment — проекция YCLIENTS. Пока интеграция выключена
 * (YCLIENTS_ENABLED=false), запись живёт только здесь; при включении сюда же
 * добавится вызов YCLIENTS перед фиксацией, а контракт функций не изменится.
 */

const TZ = "Europe/Moscow";

export interface ServiceInfo {
  id: string;
  title: string;
  price: number;
  durationMin: number;
  kind: string;
}

export interface SlotInfo {
  /** ISO-время начала в UTC. */
  startAt: string;
  /** «Пн, 5 августа, 14:30» — для показа пациенту. */
  label: string;
  staffId: string;
  staffName: string;
  roomId: string;
  roomName: string;
}

/** Минута дня в зоне клиники. */
function minuteOfDay(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

function weekdayInTz(at: Date): number {
  const name = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" }).format(at);
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[name] ?? 1;
}

export function slotLabel(at: Date): string {
  const d = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "long",
  }).format(at);
  const t = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
  return `${d}, ${t}`;
}

export async function getServices(companyId: string): Promise<ServiceInfo[]> {
  const rows = await prisma.service.findMany({
    where: { companyId, isActive: true },
    orderBy: { title: "asc" },
    select: { id: true, title: true, price: true, durationMin: true, kind: true },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    price: Number(r.price),
    durationMin: r.durationMin,
    kind: r.kind,
  }));
}

/**
 * Свободные окна на услугу. Считаются по реальному расписанию клиники за
 * вычетом уже занятого времени специалиста и кабинета.
 */
export async function getFreeSlots(input: {
  companyId: string;
  serviceId: string;
  dateFrom: Date;
  dateTo: Date;
  staffId?: string | null;
  limit?: number;
}): Promise<SlotInfo[]> {
  const { companyId, serviceId } = input;
  const limit = input.limit ?? 12;

  const service = await prisma.service.findFirst({
    where: { id: serviceId, companyId, isActive: true },
    select: { id: true, durationMin: true, kind: true },
  });
  if (!service) return [];

  // Кто выполняет услугу: специалист с подходящим кабинетом. Связь услуги с
  // кабинетом ведётся в ServiceRoom, специалиста с кабинетом — в defaultRoomId.
  const serviceRooms = await prisma.serviceRoom.findMany({
    where: { companyId, serviceId },
    select: { roomId: true },
  });
  const roomIds = serviceRooms.map((r) => r.roomId);
  if (roomIds.length === 0) return [];

  const staff = await prisma.staff.findMany({
    where: {
      companyId,
      deletedAt: null,
      isActive: true,
      defaultRoomId: { in: roomIds },
      ...(input.staffId ? { id: input.staffId } : {}),
    },
    select: { id: true, name: true, defaultRoomId: true, defaultRoom: { select: { name: true } } },
  });
  if (staff.length === 0) return [];

  const schedule = await prisma.clinicSchedule.findMany({
    where: { companyId },
    select: { weekday: true, startMinute: true, endMinute: true },
  });

  const busy = await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      status: { not: "CANCELLED" },
      startAt: { gte: input.dateFrom, lt: input.dateTo },
    },
    select: { staffId: true, roomId: true, startAt: true, endAt: true },
  });

  const slots: SlotInfo[] = [];
  const step = 30;
  const now = Date.now();

  for (let day = new Date(input.dateFrom); day < input.dateTo && slots.length < limit; ) {
    const weekday = weekdayInTz(day);
    const work = schedule.find((s) => s.weekday === weekday);
    if (work) {
      for (let minute = work.startMinute; minute + service.durationMin <= work.endMinute; minute += step) {
        if (slots.length >= limit) break;
        const start = new Date(day);
        start.setHours(0, 0, 0, 0);
        start.setMinutes(start.getMinutes() + (minute - minuteOfDay(start)));
        const end = new Date(start.getTime() + service.durationMin * 60_000);
        // Прошлое и ближайший час не предлагаем: пациенту нужно доехать.
        if (start.getTime() < now + 60 * 60_000) continue;

        for (const person of staff) {
          if (!person.defaultRoomId) continue;
          const clash = busy.some(
            (b) =>
              (b.staffId === person.id || b.roomId === person.defaultRoomId) &&
              b.startAt < end &&
              start < b.endAt,
          );
          if (clash) continue;
          slots.push({
            startAt: start.toISOString(),
            label: slotLabel(start),
            staffId: person.id,
            staffName: person.name,
            roomId: person.defaultRoomId,
            roomName: person.defaultRoom?.name ?? "",
          });
          break; // одно окно — один специалист, остальных не перечисляем
        }
      }
    }
    day = new Date(day.getTime() + 24 * 3600 * 1000);
    day.setHours(0, 0, 0, 0);
  }

  return slots;
}

export type BookingResult =
  | { ok: true; appointmentId: string; label: string; staffName: string; roomName: string }
  | { ok: false; reason: "slot_taken" | "invalid" | "closed"; message: string };

/**
 * Создать запись. Слот перепроверяется здесь же, в транзакции: список окон мог
 * устареть, пока пациент думал.
 */
export async function createBooking(input: {
  companyId: string;
  patientId: string;
  serviceId: string;
  staffId: string;
  startAt: Date;
  sourceId?: string | null;
  conversationId?: string | null;
  note?: string | null;
}): Promise<BookingResult> {
  const service = await prisma.service.findFirst({
    where: { id: input.serviceId, companyId: input.companyId, isActive: true },
    select: { id: true, durationMin: true, price: true, title: true },
  });
  if (!service) return { ok: false, reason: "invalid", message: "Услуга не найдена." };

  const staff = await prisma.staff.findFirst({
    where: { id: input.staffId, companyId: input.companyId, deletedAt: null, isActive: true },
    select: { id: true, name: true, defaultRoomId: true, defaultRoom: { select: { name: true } } },
  });
  if (!staff?.defaultRoomId) return { ok: false, reason: "invalid", message: "Специалист недоступен." };

  const start = input.startAt;
  const end = new Date(start.getTime() + service.durationMin * 60_000);

  // Внутри рабочих часов?
  const weekday = weekdayInTz(start);
  const work = await prisma.clinicSchedule.findFirst({
    where: { companyId: input.companyId, weekday },
    select: { startMinute: true, endMinute: true },
  });
  const startMinute = minuteOfDay(start);
  if (!work || startMinute < work.startMinute || startMinute + service.durationMin > work.endMinute) {
    return { ok: false, reason: "closed", message: "В это время клиника не работает." };
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Блокируем пересекающиеся строки: параллельная запись в тот же слот
      // будет ждать и увидит уже созданный визит.
      const clash = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM appointments
        WHERE "companyId" = ${input.companyId}
          AND "deletedAt" IS NULL
          AND status <> 'CANCELLED'
          AND ("staffId" = ${staff.id} OR "roomId" = ${staff.defaultRoomId})
          AND "startAt" < ${end}
          AND "endAt" > ${start}
        FOR UPDATE
      `);
      if (clash.length > 0) return null;

      return tx.appointment.create({
        data: {
          companyId: input.companyId,
          // Номер записи проставит YCLIENTS при отправке. Свой выдумывать
          // нельзя: он столкнётся с настоящим при выгрузке.
          yclientsRecordId: null,
          patientId: input.patientId,
          staffId: staff.id,
          roomId: staff.defaultRoomId,
          primaryServiceId: service.id,
          sourceId: input.sourceId ?? null,
          /**
           * Источник известен точно: запись заводится прямо в переписке, из
           * которой мы её и создаём. Оставить UNKNOWN значило бы отдать её
           * ночному пересчёту, а тот судит по окну времени и может стереть
           * то, что мы знаем наверняка.
           */
          sourceConfidence: input.sourceId ? ("DERIVED" as const) : ("UNKNOWN" as const),
          sourceDerivedAt: input.sourceId ? new Date() : null,
          conversationId: input.conversationId ?? null,
          startAt: start,
          endAt: end,
          createdAtYclients: new Date(),
          updatedAtYclients: new Date(),
          durationMin: service.durationMin,
          status: "CREATED",
          revenue: 0,
          note: input.note ?? null,
        },
        select: { id: true },
      });
    });

    if (!created) {
      return { ok: false, reason: "slot_taken", message: "Это время только что заняли. Выберите другое." };
    }
    return {
      ok: true,
      appointmentId: created.id,
      label: slotLabel(start),
      staffName: staff.name,
      roomName: staff.defaultRoom?.name ?? "",
    };
  } catch {
    return { ok: false, reason: "slot_taken", message: "Не удалось занять это время. Выберите другое." };
  }
}
