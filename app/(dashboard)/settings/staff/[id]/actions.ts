"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import {
  ALL_PERMISSIONS,
  hasPermission,
  type Permission,
  type Role,
  type RolePermissionRow,
} from "@/lib/permissions";
import type { Permission as DbPermission } from "@/generated/prisma/enums";

/**
 * Карточка сотрудника: персональные права и его работа в цифрах.
 *
 * Права — трёхпозиционные: «как у роли» (строки нет), «разрешено», «запрещено».
 * Так видно, что именно настроено лично, а что унаследовано, и роль остаётся
 * рабочей заготовкой.
 *
 * Метрики считаются по визитам привязанного специалиста. У администратора и
 * владельца специалиста нет — у них раздел приёмов пуст, и это нормально.
 */

/** null — наследуем право роли. */
export type PermissionSetting = boolean | null;

export interface StaffPermissionRow {
  permission: Permission;
  /** Что даёт роль сама по себе — показываем как подпись «как у роли». */
  fromRole: boolean;
  /** Персональное перекрытие или null. */
  personal: PermissionSetting;
  /** Итог, по которому реально пускает сервер. */
  effective: boolean;
}

export interface ServiceRow {
  service: string;
  count: number;
  revenue: number;
}

export interface WeekRow {
  label: string;
  appts: number;
  arrived: number;
  revenue: number;
}

export interface StaffMetrics {
  hasSpecialist: boolean;
  periodDays: number;
  appts: number;
  arrived: number;
  noShow: number;
  cancelled: number;
  firstVisits: number;
  repeatVisits: number;
  uniquePatients: number;
  hours: number;
  revenue: number;
  avgCheck: number;
  noShowRatePct: number;
  arrivalRatePct: number;
  /** Доля от общей выручки клиники за период. */
  revenueSharePct: number;
  services: ServiceRow[];
  weeks: WeekRow[];
  lastVisitAt: string | null;
}

export interface StaffMemberView {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  specialty: string | null;
  roomName: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  permissions: StaffPermissionRow[];
  metrics: StaffMetrics;
}

const PERIOD_DAYS = 90;

function weekKey(d: Date): number {
  const msk = new Date(d.getTime() + 3 * 3600 * 1000);
  const dow = (msk.getUTCDay() + 6) % 7;
  return Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() - dow);
}
function weekLabel(key: number): string {
  const m = new Date(key);
  return `${String(m.getUTCDate()).padStart(2, "0")}.${String(m.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function buildMetrics(companyId: string, staffId: string | null): Promise<StaffMetrics> {
  const empty: StaffMetrics = {
    hasSpecialist: false,
    periodDays: PERIOD_DAYS,
    appts: 0,
    arrived: 0,
    noShow: 0,
    cancelled: 0,
    firstVisits: 0,
    repeatVisits: 0,
    uniquePatients: 0,
    hours: 0,
    revenue: 0,
    avgCheck: 0,
    noShowRatePct: 0,
    arrivalRatePct: 0,
    revenueSharePct: 0,
    services: [],
    weeks: [],
    lastVisitAt: null,
  };
  if (!staffId) return empty;

  const since = new Date(Date.now() - PERIOD_DAYS * 24 * 3600 * 1000);
  const [rows, clinicRevenue] = await Promise.all([
    prisma.appointment.findMany({
      where: { companyId, deletedAt: null, staffId, startAt: { gte: since } },
      select: {
        startAt: true,
        durationMin: true,
        status: true,
        revenue: true,
        patientId: true,
        isFirstVisit: true,
        primaryService: { select: { title: true } },
      },
      orderBy: { startAt: "asc" },
    }),
    prisma.appointment.aggregate({
      where: { companyId, deletedAt: null, status: "ARRIVED", startAt: { gte: since } },
      _sum: { revenue: true },
    }),
  ]);

  const arrivedRows = rows.filter((r) => r.status === "ARRIVED");
  const revenue = arrivedRows.reduce((sum, r) => sum + Number(r.revenue), 0);
  const noShow = rows.filter((r) => r.status === "NO_SHOW").length;
  const cancelled = rows.filter((r) => r.status === "CANCELLED").length;
  // Знаменатель для явки — только состоявшиеся исходы: отменённые визиты не
  // вина специалиста, иначе показатель врёт при массовых отменах.
  const settled = arrivedRows.length + noShow;
  const firstVisits = arrivedRows.filter((r) => r.isFirstVisit).length;
  const hours = arrivedRows.reduce((sum, r) => sum + r.durationMin, 0) / 60;
  const patients = new Set(arrivedRows.map((r) => r.patientId).filter(Boolean));
  const totalClinic = Number(clinicRevenue._sum.revenue ?? 0);

  const byService = new Map<string, { count: number; revenue: number }>();
  for (const r of arrivedRows) {
    const key = r.primaryService?.title ?? "Без услуги";
    const acc = byService.get(key) ?? { count: 0, revenue: 0 };
    acc.count += 1;
    acc.revenue += Number(r.revenue);
    byService.set(key, acc);
  }

  const byWeek = new Map<number, { appts: number; arrived: number; revenue: number }>();
  for (const r of rows) {
    const key = weekKey(r.startAt);
    const acc = byWeek.get(key) ?? { appts: 0, arrived: 0, revenue: 0 };
    acc.appts += 1;
    if (r.status === "ARRIVED") {
      acc.arrived += 1;
      acc.revenue += Number(r.revenue);
    }
    byWeek.set(key, acc);
  }

  return {
    hasSpecialist: true,
    periodDays: PERIOD_DAYS,
    appts: rows.length,
    arrived: arrivedRows.length,
    noShow,
    cancelled,
    firstVisits,
    repeatVisits: arrivedRows.length - firstVisits,
    uniquePatients: patients.size,
    hours: Math.round(hours * 10) / 10,
    revenue,
    avgCheck: arrivedRows.length ? Math.round(revenue / arrivedRows.length) : 0,
    noShowRatePct: settled ? Math.round((noShow / settled) * 100) : 0,
    arrivalRatePct: settled ? Math.round((arrivedRows.length / settled) * 100) : 0,
    revenueSharePct: totalClinic > 0 ? Math.round((revenue / totalClinic) * 100) : 0,
    services: [...byService.entries()]
      .map(([service, v]) => ({ service, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8),
    weeks: [...byWeek.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(-8)
      .map(([key, v]) => ({ label: weekLabel(key), ...v })),
    lastVisitAt: arrivedRows.length ? arrivedRows[arrivedRows.length - 1].startAt.toISOString() : null,
  };
}

export async function getStaffMember(id: string): Promise<StaffMemberView | null> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  const user = await prisma.staffUser.findFirst({
    where: { id, companyId: session.companyId, deletedAt: null },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      staffId: true,
      lastLoginAt: true,
      createdAt: true,
      staff: { select: { specialty: true, defaultRoom: { select: { name: true } } } },
      permissions: { select: { permission: true, allowed: true } },
    },
  });
  if (!user) return null;

  const roleRows = await prisma.rolePermission.findMany({
    where: { companyId: session.companyId },
    select: { role: true, permission: true, allowed: true },
  });
  const personal = new Map(user.permissions.map((p) => [p.permission as Permission, p.allowed]));

  const permissions: StaffPermissionRow[] = ALL_PERMISSIONS.map((permission) => {
    const fromRole = hasPermission(roleRows as RolePermissionRow[], user.role as Role, permission);
    const override = personal.has(permission) ? personal.get(permission)! : null;
    return {
      permission,
      fromRole,
      personal: override,
      effective: override === null ? fromRole : override,
    };
  });

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role as Role,
    isActive: user.isActive,
    specialty: user.staff?.specialty ?? null,
    roomName: user.staff?.defaultRoom?.name ?? null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    permissions,
    metrics: await buildMetrics(session.companyId, user.staffId),
  };
}

export async function saveStaffPermissions(
  id: string,
  overrides: Record<string, PermissionSetting>,
): Promise<StaffMemberView | null> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  const user = await prisma.staffUser.findFirst({
    where: { id, companyId: session.companyId, deletedAt: null },
    select: { id: true, role: true },
  });
  if (!user) throw new Error("Сотрудник не найден");

  // Владельца нельзя лишить доступа к настройкам — иначе платформу уже никто
  // не откроет на редактирование.
  if (user.role === "OWNER" && overrides.EDIT_SETTINGS === false) {
    throw new Error("Владельцу нельзя запретить изменение настроек");
  }

  await prisma.$transaction(async (tx) => {
    for (const permission of ALL_PERMISSIONS) {
      const value = overrides[permission] ?? null;
      if (value === null) {
        await tx.userPermission.deleteMany({ where: { staffUserId: id, permission: permission as DbPermission } });
      } else {
        await tx.userPermission.upsert({
          where: { staffUserId_permission: { staffUserId: id, permission: permission as DbPermission } },
          update: { allowed: value },
          create: {
            companyId: session.companyId,
            staffUserId: id,
            permission: permission as DbPermission,
            allowed: value,
          },
        });
      }
    }
  });

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "user_permissions",
    entityId: id,
    meta: { overrides },
  });

  return getStaffMember(id);
}
