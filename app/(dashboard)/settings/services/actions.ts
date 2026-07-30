"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import type { ServiceKind } from "@/generated/prisma/enums";

/**
 * Услуги — доменные таблицы Service + ServiceRoom. Кабинеты услуги — знаменатель
 * загрузки по услугам (§8). Сохранение целиком (reconcile) в транзакции.
 * Локальные услуги имеют yclientsServiceId = null (сопоставление с YCLIENTS —
 * позже). Услугу с визитами или курсами удалить нельзя — только деактивировать.
 */
export interface ServiceRow {
  id: string; // существующие — cuid; новые — "new-*"
  title: string;
  kind: ServiceKind;
  price: number;
  durationMin: number;
  isActive: boolean;
  isCourse: boolean;
  defaultSessions: number | null;
  stalledAfterDays: number | null;
  roomIds: string[];
}

export interface ServicesPayload {
  services: ServiceRow[];
  roomOptions: { id: string; label: string }[];
}

export async function getServices(): Promise<ServicesPayload> {
  const session = await getSession();
  const [services, rooms] = await Promise.all([
    prisma.service.findMany({
      where: { companyId: session.companyId },
      orderBy: { createdAt: "asc" },
      include: { rooms: { select: { roomId: true } } },
    }),
    prisma.room.findMany({
      where: { companyId: session.companyId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  return {
    services: services.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      price: Number(s.price),
      durationMin: s.durationMin,
      isActive: s.isActive,
      isCourse: s.isCourse,
      defaultSessions: s.defaultSessions,
      stalledAfterDays: s.stalledAfterDays,
      roomIds: s.rooms.map((r) => r.roomId),
    })),
    roomOptions: rooms.map((r) => ({ id: r.id, label: r.name.replace(/ —.*/, "") })),
  };
}

export async function saveServices(rows: ServiceRow[]): Promise<ServicesPayload> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  // Валидация — платформа не даёт сохранить бессмыслицу.
  for (const s of rows) {
    if (s.title.trim().length === 0) throw new Error("У услуги должно быть название");
    if (s.isCourse && (!s.defaultSessions || s.defaultSessions < 1)) {
      throw new Error(`«${s.title}»: у курсовой услуги укажите размер курса`);
    }
    if (s.roomIds.length === 0) {
      throw new Error(`«${s.title}»: выберите хотя бы один кабинет`);
    }
  }

  const existing = await prisma.service.findMany({
    where: { companyId: session.companyId },
    select: { id: true, title: true },
  });
  const keptIds = new Set(rows.filter((r) => !r.id.startsWith("new-")).map((r) => r.id));
  const toDelete = existing.filter((e) => !keptIds.has(e.id));

  for (const del of toDelete) {
    const [visits, courses] = await Promise.all([
      prisma.appointmentService.count({ where: { serviceId: del.id } }),
      prisma.course.count({ where: { serviceId: del.id } }),
    ]);
    if (visits + courses > 0) {
      throw new Error(
        `Услугу «${del.title}» удалить нельзя: с ней связано визитов ${visits}, курсов ${courses}. Деактивируйте её.`,
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const del of toDelete) {
      await tx.service.delete({ where: { id: del.id } });
    }
    for (const r of rows) {
      const data = {
        title: r.title.trim(),
        kind: r.kind,
        price: r.price,
        durationMin: r.durationMin,
        isActive: r.isActive,
        isCourse: r.isCourse,
        defaultSessions: r.isCourse ? r.defaultSessions : null,
        stalledAfterDays: r.isCourse ? r.stalledAfterDays : null,
      };
      let serviceId = r.id;
      if (r.id.startsWith("new-")) {
        const created = await tx.service.create({
          data: { companyId: session.companyId, yclientsServiceId: null, ...data },
        });
        serviceId = created.id;
      } else {
        await tx.service.update({ where: { id: r.id }, data });
      }
      // Синхронизация кабинетов услуги.
      const current = await tx.serviceRoom.findMany({
        where: { serviceId },
        select: { roomId: true },
      });
      const currentIds = new Set(current.map((c) => c.roomId));
      const wanted = new Set(r.roomIds);
      const toRemove = [...currentIds].filter((id) => !wanted.has(id));
      const toAdd = [...wanted].filter((id) => !currentIds.has(id));
      if (toRemove.length) {
        await tx.serviceRoom.deleteMany({ where: { serviceId, roomId: { in: toRemove } } });
      }
      for (const roomId of toAdd) {
        await tx.serviceRoom.create({
          data: { companyId: session.companyId, serviceId, roomId },
        });
      }
    }
  });

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "services",
    meta: { count: rows.length, deleted: toDelete.length },
  });

  return getServices();
}
