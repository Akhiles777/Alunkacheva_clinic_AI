import { describe, expect, it } from "vitest";
import {
  hasPermission,
  permissionChecker,
  resolvePermissions,
  type Permission,
  type Role,
  type RolePermissionRow,
} from "./permissions";

// Матрица по умолчанию из сида.
const DEFAULTS: Record<Role, Permission[]> = {
  OWNER: ["VIEW_OTHER_PATIENTS", "VIEW_REVENUE", "EDIT_SETTINGS", "MESSAGE_PATIENTS", "VIEW_AUDIT"],
  MANAGER: ["VIEW_OTHER_PATIENTS", "VIEW_REVENUE", "MESSAGE_PATIENTS", "VIEW_AUDIT"],
  ADMIN: ["VIEW_OTHER_PATIENTS", "MESSAGE_PATIENTS"],
  DOCTOR: [],
};
const ALL: Permission[] = [
  "VIEW_OTHER_PATIENTS",
  "VIEW_REVENUE",
  "EDIT_SETTINGS",
  "MESSAGE_PATIENTS",
  "VIEW_AUDIT",
];

function buildMatrix(): RolePermissionRow[] {
  const rows: RolePermissionRow[] = [];
  for (const role of Object.keys(DEFAULTS) as Role[]) {
    const allowed = new Set(DEFAULTS[role]);
    for (const permission of ALL) {
      rows.push({ role, permission, allowed: allowed.has(permission) });
    }
  }
  return rows;
}

const matrix = buildMatrix();

describe("hasPermission", () => {
  it("владелец может всё", () => {
    for (const p of ALL) expect(hasPermission(matrix, "OWNER", p)).toBe(true);
  });

  it("врач не видит чужих пациентов и не пишет пациентам", () => {
    expect(hasPermission(matrix, "DOCTOR", "VIEW_OTHER_PATIENTS")).toBe(false);
    expect(hasPermission(matrix, "DOCTOR", "MESSAGE_PATIENTS")).toBe(false);
  });

  it("администратор пишет пациентам, но не видит выручку и не меняет настройки", () => {
    expect(hasPermission(matrix, "ADMIN", "MESSAGE_PATIENTS")).toBe(true);
    expect(hasPermission(matrix, "ADMIN", "VIEW_REVENUE")).toBe(false);
    expect(hasPermission(matrix, "ADMIN", "EDIT_SETTINGS")).toBe(false);
  });

  it("управляющий видит выручку и аудит, но не меняет настройки", () => {
    expect(hasPermission(matrix, "MANAGER", "VIEW_REVENUE")).toBe(true);
    expect(hasPermission(matrix, "MANAGER", "VIEW_AUDIT")).toBe(true);
    expect(hasPermission(matrix, "MANAGER", "EDIT_SETTINGS")).toBe(false);
  });

  it("запрещено по умолчанию: нет строки — нет доступа", () => {
    expect(hasPermission([], "OWNER", "VIEW_REVENUE")).toBe(false);
  });

  it("allowed=false явно закрывает", () => {
    const denied: RolePermissionRow[] = [
      { role: "ADMIN", permission: "EDIT_SETTINGS", allowed: false },
    ];
    expect(hasPermission(denied, "ADMIN", "EDIT_SETTINGS")).toBe(false);
  });
});

describe("resolvePermissions и checker", () => {
  it("возвращает набор прав роли", () => {
    expect(resolvePermissions(matrix, "ADMIN")).toEqual(
      new Set<Permission>(["VIEW_OTHER_PATIENTS", "MESSAGE_PATIENTS"]),
    );
  });

  it("предикат совпадает с hasPermission", () => {
    const canManager = permissionChecker(matrix, "MANAGER");
    for (const p of ALL) expect(canManager(p)).toBe(hasPermission(matrix, "MANAGER", p));
  });
});
