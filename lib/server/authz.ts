import { prisma } from "@/lib/db";
import { hasPermission, type Permission, type Role, type RolePermissionRow } from "@/lib/permissions";

/**
 * Серверная проверка прав по ролям (§9): читает матрицу RolePermission из БД и
 * решает по чистой функции hasPermission. Роли ограничивают доступ реально, на
 * сервере, а не только прячут кнопки в интерфейсе.
 */
export async function can(companyId: string, role: Role, permission: Permission): Promise<boolean> {
  const rows = await prisma.rolePermission.findMany({
    where: { companyId },
    select: { role: true, permission: true, allowed: true },
  });
  return hasPermission(rows as RolePermissionRow[], role, permission);
}

/** Кидает, если права нет. Использовать в начале каждого server action. */
export async function requirePermission(
  session: { companyId: string; role: Role },
  permission: Permission,
): Promise<void> {
  if (!(await can(session.companyId, session.role, permission))) {
    throw new Error("Недостаточно прав для этого действия");
  }
}
