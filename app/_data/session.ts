/**
 * Мок текущего сотрудника. Настоящая сессия и серверная проверка прав — позже;
 * здесь роль задаётся статически, чтобы гейты по правам работали в интерфейсе.
 */
import { hasPermission, type Permission, type Role, type RolePermissionRow } from "@/lib/permissions";
import { settingsStore } from "./settings";

export const currentUser: { name: string; role: Role } = {
  name: "Ольга Мерова",
  role: "OWNER",
};

/** Матрица прав из стора в виде строк для lib/permissions. */
export function permissionRows(): RolePermissionRow[] {
  const rows: RolePermissionRow[] = [];
  const all: Permission[] = [
    "VIEW_OTHER_PATIENTS",
    "VIEW_REVENUE",
    "EDIT_SETTINGS",
    "MESSAGE_PATIENTS",
    "VIEW_AUDIT",
  ];
  for (const role of Object.keys(settingsStore.roleMatrix) as Role[]) {
    const allowed = new Set(settingsStore.roleMatrix[role]);
    for (const permission of all) {
      rows.push({ role, permission, allowed: allowed.has(permission) });
    }
  }
  return rows;
}

export function currentCan(permission: Permission): boolean {
  return hasPermission(permissionRows(), currentUser.role, permission);
}
