"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import type { StaffRole } from "@/generated/prisma/enums";

/**
 * Специалисты (Staff) и учётные записи (StaffUser). Удаление — мягкое (deletedAt,
 * §4), потому что на специалистов ссылаются визиты (Appointment.staffId Restrict).
 * Локальные специалисты имеют yclientsStaffId = null. Платформа не даёт остаться
 * без активного владельца.
 */
export interface SpecialistRow {
  id: string; // существующие — cuid; новые — "new-*"
  name: string;
  specialty: string;
  defaultRoomId: string | null;
  isActive: boolean;
}

export interface AccountRow {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  isActive: boolean;
  staffId: string | null;
}

export interface StaffPeople {
  specialists: SpecialistRow[];
  accounts: AccountRow[];
  roomOptions: { id: string; label: string }[];
  specialistOptions: { id: string; name: string }[];
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const INVITE_PENDING = "!invite-pending"; // не совпадёт ни с одним хэшем при логине

export async function getStaffPeople(): Promise<StaffPeople> {
  const session = await getSession();
  const [staff, accounts, rooms] = await Promise.all([
    prisma.staff.findMany({
      where: { companyId: session.companyId, deletedAt: null },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.staffUser.findMany({
      where: { companyId: session.companyId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    }),
    prisma.room.findMany({
      where: { companyId: session.companyId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  return {
    specialists: staff.map((s) => ({
      id: s.id,
      name: s.name,
      specialty: s.specialty ?? "",
      defaultRoomId: s.defaultRoomId,
      isActive: s.isActive,
    })),
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      role: a.role,
      isActive: a.isActive,
      staffId: a.staffId,
    })),
    roomOptions: rooms.map((r) => ({ id: r.id, label: r.name.replace(/ —.*/, "") })),
    specialistOptions: staff.map((s) => ({ id: s.id, name: s.name })),
  };
}

export async function saveSpecialists(rows: SpecialistRow[]): Promise<StaffPeople> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  if (rows.some((r) => r.name.trim().length === 0)) {
    throw new Error("У специалиста должно быть имя");
  }

  const existing = await prisma.staff.findMany({
    where: { companyId: session.companyId, deletedAt: null },
    select: { id: true },
  });
  const kept = new Set(rows.filter((r) => !r.id.startsWith("new-")).map((r) => r.id));
  const toDelete = existing.filter((e) => !kept.has(e.id));

  await prisma.$transaction(async (tx) => {
    for (const del of toDelete) {
      await tx.staff.update({
        where: { id: del.id },
        data: { deletedAt: new Date(), isActive: false, defaultRoomId: null },
      });
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const data = {
        name: r.name.trim(),
        specialty: r.specialty.trim() || null,
        defaultRoomId: r.defaultRoomId || null,
        isActive: r.isActive,
        sortOrder: i + 1,
      };
      if (r.id.startsWith("new-")) {
        await tx.staff.create({
          data: { companyId: session.companyId, yclientsStaffId: null, ...data },
        });
      } else {
        await tx.staff.update({ where: { id: r.id }, data });
      }
    }
  });

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "staff",
    meta: { count: rows.length, deleted: toDelete.length },
  });

  return getStaffPeople();
}

export async function saveAccounts(rows: AccountRow[]): Promise<StaffPeople> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  // Валидация почты и уникальности в наборе.
  const seen = new Set<string>();
  for (const a of rows) {
    const email = a.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error(`Проверьте почту: ${a.name || email}`);
    if (seen.has(email)) throw new Error(`Почта повторяется: ${email}`);
    seen.add(email);
  }
  // Нельзя остаться без активного владельца.
  if (!rows.some((a) => a.role === "OWNER" && a.isActive)) {
    throw new Error("Должен остаться хотя бы один активный владелец");
  }

  const existing = await prisma.staffUser.findMany({
    where: { companyId: session.companyId, deletedAt: null },
    select: { id: true },
  });
  const kept = new Set(rows.filter((r) => !r.id.startsWith("new-")).map((r) => r.id));
  const toDelete = existing.filter((e) => !kept.has(e.id));

  await prisma.$transaction(async (tx) => {
    for (const del of toDelete) {
      await tx.staffUser.update({
        where: { id: del.id },
        data: { deletedAt: new Date(), isActive: false },
      });
    }
    for (const r of rows) {
      const data = {
        name: r.name.trim(),
        email: r.email.trim().toLowerCase(),
        role: r.role,
        isActive: r.isActive,
        staffId: r.staffId || null,
      };
      if (r.id.startsWith("new-")) {
        await tx.staffUser.create({
          data: { companyId: session.companyId, passwordHash: INVITE_PENDING, ...data },
        });
      } else {
        await tx.staffUser.update({ where: { id: r.id }, data });
      }
    }
  });

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "accounts",
    meta: { count: rows.length, deleted: toDelete.length },
  });

  return getStaffPeople();
}
