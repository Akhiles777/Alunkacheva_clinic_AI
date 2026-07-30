"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";

/**
 * Кабинеты — доменная таблица Room (не мок, не Setting-блок). Локально созданные
 * кабинеты имеют yclientsResourceId = null (сопоставление с ресурсом YCLIENTS —
 * позже вебхуком). Привязка сотрудников — через Staff.defaultRoomId (§4.
 * «специалист → кабинет»), необязательная.
 *
 * Платформа не даёт навести беспорядок: кабинет, занятый услугой или визитами,
 * удалить нельзя — только деактивировать.
 */
export interface RoomRow {
  id: string;
  name: string;
  direction: string;
  isActive: boolean;
  inheritsClinicSchedule: boolean;
  sortOrder: number;
  staffIds: string[];
}

export interface RoomInput {
  name: string;
  direction: string;
  isActive: boolean;
  inheritsClinicSchedule: boolean;
  staffIds: string[];
}

export interface RoomsPayload {
  rooms: RoomRow[];
  staffOptions: { id: string; name: string }[];
  nameSuggestions: string[];
  directionSuggestions: string[];
}

const BASE_NAME_SUGGESTIONS = [
  "Кабинет 1 — процедурный",
  "Кабинет 2 — БОС-терапии",
  "Кабинет 3 — остеопата",
  "Процедурный кабинет",
  "Кабинет остеопата",
];
const BASE_DIRECTION_SUGGESTIONS = [
  "IV-терапия",
  "БОС-терапия",
  "Остеопатия",
  "Нейромедитация",
  "Анализы",
];

function uniq(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v && v.trim().length > 0))];
}

async function readRooms(companyId: string): Promise<RoomRow[]> {
  const [rooms, staff] = await Promise.all([
    prisma.room.findMany({ where: { companyId }, orderBy: { sortOrder: "asc" } }),
    prisma.staff.findMany({
      where: { companyId, deletedAt: null, defaultRoomId: { not: null } },
      select: { id: true, defaultRoomId: true },
    }),
  ]);
  const byRoom = new Map<string, string[]>();
  for (const s of staff) {
    if (!s.defaultRoomId) continue;
    const list = byRoom.get(s.defaultRoomId) ?? [];
    list.push(s.id);
    byRoom.set(s.defaultRoomId, list);
  }
  return rooms.map((r) => ({
    id: r.id,
    name: r.name,
    direction: r.direction ?? "",
    isActive: r.isActive,
    inheritsClinicSchedule: r.inheritsClinicSchedule,
    sortOrder: r.sortOrder,
    staffIds: byRoom.get(r.id) ?? [],
  }));
}

export async function getRooms(): Promise<RoomsPayload> {
  const session = await getSession();
  const [rooms, staffOptions] = await Promise.all([
    readRooms(session.companyId),
    prisma.staff.findMany({
      where: { companyId: session.companyId, deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { sortOrder: "asc" },
    }),
  ]);
  return {
    rooms,
    staffOptions,
    nameSuggestions: uniq([...BASE_NAME_SUGGESTIONS, ...rooms.map((r) => r.name)]),
    directionSuggestions: uniq([...BASE_DIRECTION_SUGGESTIONS, ...rooms.map((r) => r.direction)]),
  };
}

/** Приводит Staff.defaultRoomId к желаемому набору сотрудников для кабинета. */
async function reconcileStaff(companyId: string, roomId: string, staffIds: string[]) {
  const valid = await prisma.staff.findMany({
    where: { companyId, deletedAt: null, id: { in: staffIds } },
    select: { id: true },
  });
  const wanted = new Set(valid.map((s) => s.id));
  await prisma.$transaction([
    // отвязать тех, кто был на этом кабинете, но больше не выбран
    prisma.staff.updateMany({
      where: { companyId, defaultRoomId: roomId, id: { notIn: [...wanted] } },
      data: { defaultRoomId: null },
    }),
    // привязать выбранных
    prisma.staff.updateMany({
      where: { companyId, id: { in: [...wanted] } },
      data: { defaultRoomId: roomId },
    }),
  ]);
}

export async function createRoom(input: RoomInput): Promise<RoomsPayload> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  const name = input.name.trim();
  if (!name) throw new Error("У кабинета не может быть пустого названия");

  const max = await prisma.room.aggregate({
    where: { companyId: session.companyId },
    _max: { sortOrder: true },
  });
  const room = await prisma.room.create({
    data: {
      companyId: session.companyId,
      yclientsResourceId: null,
      name,
      direction: input.direction.trim() || null,
      isActive: input.isActive,
      inheritsClinicSchedule: input.inheritsClinicSchedule,
      sortOrder: (max._max.sortOrder ?? 0) + 1,
    },
  });
  await reconcileStaff(session.companyId, room.id, input.staffIds);
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "rooms",
    entityId: room.id,
    meta: { op: "create", name },
  });
  return getRooms();
}

export async function updateRoom(id: string, input: RoomInput): Promise<RoomsPayload> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  const name = input.name.trim();
  if (!name) throw new Error("У кабинета не может быть пустого названия");

  const existing = await prisma.room.findFirst({ where: { id, companyId: session.companyId } });
  if (!existing) throw new Error("Кабинет не найден");

  await prisma.room.update({
    where: { id },
    data: {
      name,
      direction: input.direction.trim() || null,
      isActive: input.isActive,
      inheritsClinicSchedule: input.inheritsClinicSchedule,
    },
  });
  await reconcileStaff(session.companyId, id, input.staffIds);
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "rooms",
    entityId: id,
    meta: { op: "update", name },
  });
  return getRooms();
}

export async function deleteRoom(id: string): Promise<RoomsPayload> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  const existing = await prisma.room.findFirst({ where: { id, companyId: session.companyId } });
  if (!existing) throw new Error("Кабинет не найден");

  const [apptCount, serviceLinks] = await Promise.all([
    prisma.appointment.count({ where: { roomId: id } }),
    prisma.serviceRoom.findMany({
      where: { roomId: id },
      select: { service: { select: { title: true } } },
    }),
  ]);
  if (apptCount > 0) {
    throw new Error(
      `Кабинет нельзя удалить: с ним связано визитов — ${apptCount}. Деактивируйте его вместо удаления.`,
    );
  }
  if (serviceLinks.length > 0) {
    const titles = serviceLinks.map((l) => `«${l.service.title}»`).join(", ");
    throw new Error(
      `Кабинет используется услугами: ${titles}. Сначала отвяжите его в разделе «Услуги».`,
    );
  }

  // Освобождаем закреплённых сотрудников и удаляем (расписания кабинета уйдут каскадом).
  await prisma.staff.updateMany({
    where: { companyId: session.companyId, defaultRoomId: id },
    data: { defaultRoomId: null },
  });
  await prisma.room.delete({ where: { id } });
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "rooms",
    entityId: id,
    meta: { op: "delete", name: existing.name },
  });
  return getRooms();
}
