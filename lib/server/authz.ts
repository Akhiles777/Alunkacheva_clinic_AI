import { prisma } from "@/lib/db";
import {
  ALL_PERMISSIONS,
  effectivePermission,
  type Permission,
  type Role,
  type RolePermissionRow,
  type UserPermissionRow,
} from "@/lib/permissions";

/**
 * Серверная проверка прав (§9). Два уровня, и порядок важен:
 *
 *   1. персональное право сотрудника (UserPermission) — если строка есть, она и решает;
 *   2. иначе матрица роли (RolePermission).
 *
 * Роль остаётся разумной заготовкой, а доступ настраивается по каждому человеку.
 * Решение принимает чистая функция hasPermission, чтобы логику можно было тестировать.
 */
export interface AuthzSubject {
  companyId: string;
  userId: string | null;
  role: Role;
}

export async function can(subject: AuthzSubject, permission: Permission): Promise<boolean> {
  const [roleRows, personal] = await Promise.all([
    prisma.rolePermission.findMany({
      where: { companyId: subject.companyId },
      select: { role: true, permission: true, allowed: true },
    }),
    subject.userId
      ? prisma.userPermission.findMany({
          where: { staffUserId: subject.userId, permission },
          select: { permission: true, allowed: true },
        })
      : Promise.resolve([]),
  ]);
  return effectivePermission(
    roleRows as RolePermissionRow[],
    subject.role,
    personal as UserPermissionRow[],
    permission,
  );
}

/** Полный набор прав сотрудника: роль плюс персональные перекрытия. */
export async function resolveFor(subject: AuthzSubject): Promise<Record<Permission, boolean>> {
  const [roleRows, personal] = await Promise.all([
    prisma.rolePermission.findMany({
      where: { companyId: subject.companyId },
      select: { role: true, permission: true, allowed: true },
    }),
    subject.userId
      ? prisma.userPermission.findMany({
          where: { staffUserId: subject.userId },
          select: { permission: true, allowed: true },
        })
      : Promise.resolve([]),
  ]);

  const result = {} as Record<Permission, boolean>;
  for (const permission of ALL_PERMISSIONS) {
    result[permission] = effectivePermission(
      roleRows as RolePermissionRow[],
      subject.role,
      personal as UserPermissionRow[],
      permission,
    );
  }
  return result;
}

/** Кидает, если права нет. Использовать в начале каждого server action. */
export async function requirePermission(subject: AuthzSubject, permission: Permission): Promise<void> {
  if (!(await can(subject, permission))) {
    throw new Error("Недостаточно прав для этого действия");
  }
}
