/**
 * Роли приложения. Роль определяется учётной записью вошедшего пользователя
 * (сессия), а не клиентским переключателем — «левых» сотрудников больше нет.
 */
export type AppRole = "owner" | "admin" | "doctor";

export const ROLE_LABEL: Record<AppRole, string> = {
  owner: "Владелец",
  admin: "Администратор",
  doctor: "Врач",
};

/** StaffRole (БД) → роль приложения. */
export function appRoleOf(role: string): AppRole {
  if (role === "OWNER") return "owner";
  if (role === "DOCTOR") return "doctor";
  return "admin";
}
