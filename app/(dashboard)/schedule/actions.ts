"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import type { Appt } from "@/app/_data/store";
import type { AppointmentStatus } from "@/generated/prisma/enums";

/**
 * Расписание/«Сегодня» из ЕДИНОГО источника — проекции Appointment в БД (та же,
 * что читает отчёт владельца). Клиентский стор гидрируется отсюда и пишет сквозь
 * (write-through) с общими id, поэтому владелец, админ и врач видят одно и то же,
 * и данные переживают перезагрузку.
 */
const ROOM_KEY = (name: string): string =>
  name.startsWith("Кабинет 1") ? "room-1" : name.startsWith("Кабинет 2") ? "room-2" : "room-3";

const TO_STORE: Record<string, Appt["status"]> = {
  ARRIVED: "arrived",
  NO_SHOW: "no_show",
  CONFIRMED: "confirmed",
  CREATED: "planned",
};
const TO_DB: Record<Appt["status"], AppointmentStatus> = {
  arrived: "ARRIVED",
  no_show: "NO_SHOW",
  confirmed: "CONFIRMED",
  planned: "CREATED",
};

function minuteOfDay(at: Date, tz = "Europe/Moscow"): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}
/** Москва — UTC+3 круглый год (без перехода), поэтому смещение фиксированное. */
function startAtFromMinute(startMinute: number): Date {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const hh = String(Math.floor(startMinute / 60)).padStart(2, "0");
  const mm = String(startMinute % 60).padStart(2, "0");
  return new Date(`${date}T${hh}:${mm}:00+03:00`);
}

export async function getAppointmentsForStore(): Promise<Appt[]> {
  const session = await getSession();
  const rows = await prisma.appointment.findMany({
    where: { companyId: session.companyId, deletedAt: null, status: { not: "CANCELLED" } },
    include: {
      staff: { select: { name: true } },
      room: { select: { name: true } },
      primaryService: { select: { title: true } },
      patient: { select: { name: true } },
    },
    orderBy: { startAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    roomId: r.room ? ROOM_KEY(r.room.name) : "room-1",
    roomName: r.room?.name ?? "",
    doctor: r.staff.name,
    service: r.primaryService?.title ?? "",
    patientId: r.patientId,
    patientName: r.patient?.name ?? "",
    startMinute: minuteOfDay(r.startAt),
    durationMin: r.durationMin,
    status: TO_STORE[r.status] ?? "planned",
    isFirstVisit: r.isFirstVisit,
  }));
}

export async function setApptStatusDb(id: string, status: Appt["status"]): Promise<void> {
  const session = await getSession();
  await prisma.appointment.updateMany({
    where: { id, companyId: session.companyId },
    data: { status: TO_DB[status], attendanceRaw: status === "arrived" ? 1 : status === "no_show" ? -1 : null },
  });
}

export async function rescheduleApptDb(id: string, startMinute: number): Promise<void> {
  const session = await getSession();
  const row = await prisma.appointment.findFirst({ where: { id, companyId: session.companyId }, select: { durationMin: true } });
  if (!row) return;
  const startAt = startAtFromMinute(startMinute);
  const endAt = new Date(startAt.getTime() + row.durationMin * 60_000);
  await prisma.appointment.updateMany({ where: { id, companyId: session.companyId }, data: { startAt, endAt, updatedAtYclients: startAt } });
}

export interface CreateApptInput {
  id: string;
  roomId: string; // room-1/2/3
  doctor: string;
  service: string;
  patientId: string | null;
  patientName: string;
  startMinute: number;
  durationMin: number;
  status: Appt["status"];
}

export async function createAppointmentDb(input: CreateApptInput): Promise<void> {
  const session = await getSession();
  const co = session.companyId;

  const roomNum = input.roomId.replace("room-", "");
  const [staff, room, service] = await Promise.all([
    prisma.staff.findFirst({ where: { companyId: co, deletedAt: null, name: { startsWith: input.doctor.split(/\s/)[0] } }, select: { id: true } }),
    prisma.room.findFirst({ where: { companyId: co, name: { startsWith: `Кабинет ${roomNum}` } }, select: { id: true } }),
    input.service
      ? prisma.service.findFirst({ where: { companyId: co, title: input.service }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  if (!staff || !room) return; // без обязательных связей запись в проекцию не создаём

  // Пациент обязателен: находим по id/имени или заводим нового.
  let patientId = input.patientId;
  if (!patientId) {
    const found = await prisma.patient.findFirst({ where: { companyId: co, name: input.patientName.trim() }, select: { id: true } });
    patientId = found?.id ?? (await prisma.patient.create({ data: { companyId: co, name: input.patientName.trim(), firstSeenAt: new Date() } })).id;
  }

  const startAt = startAtFromMinute(input.startMinute);
  const endAt = new Date(startAt.getTime() + input.durationMin * 60_000);
  await prisma.appointment.create({
    data: {
      id: input.id,
      companyId: co,
      // Локальная запись до синка с YCLIENTS — синтетический recordId.
      yclientsRecordId: 700_000_000 + Math.floor(Math.random() * 99_999_999),
      patientId,
      staffId: staff.id,
      roomId: room.id,
      primaryServiceId: service?.id ?? null,
      startAt,
      endAt,
      durationMin: input.durationMin,
      status: TO_DB[input.status],
      isFirstVisit: false,
      revenue: 0,
      createdAtYclients: startAt,
      updatedAtYclients: startAt,
    },
  });
}
