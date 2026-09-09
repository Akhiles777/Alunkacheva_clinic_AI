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

/** Полный перечень прав — единственный список, от которого пляшут UI и сервер. */
export const ALL_PERMISSIONS: Permission[] = [
  "VIEW_OTHER_PATIENTS",
  "VIEW_REVENUE",
  "EDIT_SETTINGS",
  "MESSAGE_PATIENTS",
  "VIEW_AUDIT",
];

/**
 * Права ролей при заведении клиники.
 *
 * Здесь, а не в `prisma/seed.ts`, потому что тот же набор нужен местной
 * песочнице: без матрицы любая проверка инбокса упиралась в «Нет права писать
 * пациентам», и проверка показывала не то, что видит администратор. Две копии
 * одной матрицы однажды разъедутся, и разойдутся вместе с ними права.
 *
 * Это стартовое значение: дальше клиника правит матрицу в настройках, и
 * пересев её не трогает.
 */
export const ROLE_MATRIX: Record<Role, Permission[]> = {
  OWNER: ["VIEW_OTHER_PATIENTS", "VIEW_REVENUE", "EDIT_SETTINGS", "MESSAGE_PATIENTS", "VIEW_AUDIT"],
  MANAGER: ["VIEW_OTHER_PATIENTS", "VIEW_REVENUE", "MESSAGE_PATIENTS", "VIEW_AUDIT"],
  // Администратор ведёт клинику ежедневно: заводит сотрудников, услуги и цены.
  // Без EDIT_SETTINGS пункт «Настройки» превращался в кнопку, которая падает.
  ADMIN: ["VIEW_OTHER_PATIENTS", "MESSAGE_PATIENTS", "EDIT_SETTINGS"],
  DOCTOR: [],
};

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

/** Персональное перекрытие права. Строки нет — наследуем роль. */
export interface UserPermissionRow {
  permission: Permission;
  allowed: boolean;
}

/**
 * Итоговое право сотрудника: персональная настройка перекрывает роль, и только
 * при её отсутствии действует матрица роли. Порядок обратный ломает смысл —
 * персональный запрет должен переживать щедрую роль.
 */
export function effectivePermission(
  matrix: RolePermissionRow[],
  role: Role,
  personal: UserPermissionRow[],
  permission: Permission,
): boolean {
  const override = personal.find((p) => p.permission === permission);
  if (override) return override.allowed;
  return hasPermission(matrix, role, permission);
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
