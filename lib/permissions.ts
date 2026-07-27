/**
 * Проверка прав по ролям. Матрица RolePermission редактируется в настройках,
 * а сервер спрашивает эти функции в каждом запросе (§4.4, §9). Правило —
 * «запрещено по умолчанию»: нет явного allowed=true — доступа нет.
 */
export type Role = "OWNER" | "ADMIN" | "MANAGER" | "DOCTOR";

export type Permission =
  | "VIEW_OTHER_PATIENTS"
  | "VIEW_REVENUE"
  | "EDIT_SETTINGS"
  | "MESSAGE_PATIENTS"
  | "VIEW_AUDIT";

export interface RolePermissionRow {
  role: Role;
  permission: Permission;
  allowed: boolean;
}

/** Есть ли у роли право. Нет строки или allowed=false → нет доступа. */
export function hasPermission(
  matrix: RolePermissionRow[],
  role: Role,
  permission: Permission,
): boolean {
  const row = matrix.find((r) => r.role === role && r.permission === permission);
  return row?.allowed === true;
}

/** Полный набор разрешённых прав роли. */
export function resolvePermissions(matrix: RolePermissionRow[], role: Role): Set<Permission> {
  return new Set(
    matrix.filter((r) => r.role === role && r.allowed).map((r) => r.permission),
  );
}

/**
 * Готовый предикат для роли — чтобы серверная проверка не таскала матрицу в
 * каждый вызов. Нет прав — deny.
 */
export function permissionChecker(
  matrix: RolePermissionRow[],
  role: Role,
): (permission: Permission) => boolean {
  const allowed = resolvePermissions(matrix, role);
  return (permission) => allowed.has(permission);
}
