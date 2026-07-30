"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import type { Permission, Role } from "@/lib/permissions";
import type { Permission as DbPermission, StaffRole } from "@/generated/prisma/enums";

/**
 * Матрица прав по ролям — в БД (таблица RolePermission, §9). Проверка прав в
 * приложении читает именно эти строки, поэтому изменение здесь реально меняет
 * доступ, а не только внешний вид.
 */
const ROLES: Role[] = ["OWNER", "MANAGER", "ADMIN", "DOCTOR"];
const PERMISSIONS: Permission[] = [
  "VIEW_OTHER_PATIENTS",
  "VIEW_REVENUE",
  "EDIT_SETTINGS",
  "MESSAGE_PATIENTS",
  "VIEW_AUDIT",
];

export type RoleMatrix = Record<Role, Permission[]>;

export async function getRoleMatrix(): Promise<RoleMatrix> {
  const session = await getSession();
  const rows = await prisma.rolePermission.findMany({
    where: { companyId: session.companyId },
    select: { role: true, permission: true, allowed: true },
  });
  const matrix: RoleMatrix = { OWNER: [], MANAGER: [], ADMIN: [], DOCTOR: [] };
  for (const r of rows) {
    if (r.allowed) matrix[r.role as Role].push(r.permission as Permission);
  }
  return matrix;
}

export async function saveRoleMatrix(matrix: RoleMatrix): Promise<{ ok: true }> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  // Защита: владелец обязан сохранять право менять настройки — иначе матрицу
  // уже никто не откроет на редактирование.
  if (!matrix.OWNER.includes("EDIT_SETTINGS")) {
    throw new Error("Владелец должен сохранять право менять настройки");
  }

  await prisma.$transaction(
    ROLES.flatMap((role) =>
      PERMISSIONS.map((permission) =>
        prisma.rolePermission.upsert({
          where: {
            companyId_role_permission: {
              companyId: session.companyId,
              role: role as StaffRole,
              permission: permission as DbPermission,
            },
          },
          update: { allowed: matrix[role].includes(permission) },
          create: {
            companyId: session.companyId,
            role: role as StaffRole,
            permission: permission as DbPermission,
            allowed: matrix[role].includes(permission),
          },
        }),
      ),
    ),
  );

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "role-matrix",
  });

  return { ok: true };
}
