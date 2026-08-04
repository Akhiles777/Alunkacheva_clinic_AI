"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { appRoleOf, type AppRole } from "@/lib/roles";

/**
 * Текущий пользователь из сессии — источник роли и личности (для сайдбара,
 * кабинета врача, чата). Никаких захардкоженных сотрудников.
 */
export interface CurrentUser {
  id: string | null;
  name: string;
  login: string;
  role: AppRole;
  /** Кабинет врача (если у учётки есть привязанный специалист). */
  roomName: string | null;
  /**
   * Может ли пользователь менять настройки — берётся из матрицы прав, а не из
   * роли. Интерфейс обязан спрашивать то же, что проверяет сервер, иначе
   * получаются кнопки, которые падают с «Недостаточно прав».
   */
  canEditSettings: boolean;
}

export async function getCurrentUser(): Promise<CurrentUser> {
  const session = await getSession();
  const canEditSettings = await can(session, "EDIT_SETTINGS");
  if (session.userId) {
    const u = await prisma.staffUser.findUnique({
      where: { id: session.userId },
      select: { id: true, name: true, login: true, role: true, staff: { select: { defaultRoom: { select: { name: true } } } } },
    });
    if (u) {
      return {
        id: u.id,
        name: u.name,
        login: u.login,
        role: appRoleOf(u.role),
        roomName: u.staff?.defaultRoom?.name ?? null,
        canEditSettings,
      };
    }
  }
  // Фоллбэк (dev-сессия владельца без userId).
  return {
    id: null,
    name: "Владелец",
    login: "",
    role: appRoleOf(session.role),
    roomName: null,
    canEditSettings,
  };
}
