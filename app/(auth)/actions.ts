"use server";

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { hashPassword, SESSION_COOKIE, signSession, verifyPassword } from "@/lib/auth";
import { appRoleOf, type AppRole } from "@/lib/roles";
import type { StaffRole } from "@/generated/prisma/enums";
import { CLINIC_MAIL_DOMAIN } from "@/lib/brand";

/**
 * Вход/регистрация. Владелец может войти без регистрации (кнопка «Войти как
 * владелец») — под засеянной учёткой владельца. Пароли хэшируются (scrypt),
 * сессия — подписанная кука.
 */
export interface AuthResult {
  ok: boolean;
  role?: AppRole;
  error?: string;
}

async function companyId(): Promise<string | null> {
  const c = await prisma.company.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  return c?.id ?? null;
}

async function setSession(userId: string, cid: string, role: StaffRole) {
  const token = signSession({ userId, companyId: cid, role });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
  });
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Открыта ли свободная регистрация. По умолчанию — нет: это CRM с медицинскими
 * данными, и публичная форма, выдающая права администратора любому желающему,
 * — дыра, а не удобство. Сотрудников заводит владелец в настройках.
 * Исключение — первый запуск: пока в клинике нет ни одной учётки, регистрация
 * разрешена и создаёт владельца, иначе в свежую установку не войти.
 */
export async function isSelfRegistrationOpen(): Promise<boolean> {
  if (process.env.ALLOW_SELF_REGISTRATION === "true") return true;
  const cid = await companyId();
  if (!cid) return false;
  const count = await prisma.staffUser.count({ where: { companyId: cid, deletedAt: null } });
  return count === 0;
}

export async function registerUser(input: { name: string; email: string; password: string }): Promise<AuthResult> {
  const cid = await companyId();
  if (!cid) return { ok: false, error: "Клиника не настроена" };

  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (name.length < 2) return { ok: false, error: "Укажите имя" };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Проверьте почту" };
  if (input.password.length < 6) return { ok: false, error: "Пароль не короче 6 символов" };

  const existingCount = await prisma.staffUser.count({ where: { companyId: cid, deletedAt: null } });
  const bootstrap = existingCount === 0;
  if (!bootstrap && process.env.ALLOW_SELF_REGISTRATION !== "true") {
    return {
      ok: false,
      error: "Свободная регистрация закрыта. Учётную запись заводит владелец в «Настройки → Сотрудники».",
    };
  }

  // Уникальность почты в БД не смотрит на deletedAt — проверяем и удалённых.
  const exists = await prisma.staffUser.findFirst({ where: { companyId: cid, email }, select: { id: true } });
  if (exists) return { ok: false, error: "Пользователь с такой почтой уже есть" };

  // Первый сотрудник свежей установки — владелец: иначе некому раздать доступы.
  const role = bootstrap ? "OWNER" : "ADMIN";
  const user = await prisma.staffUser.create({
    data: { companyId: cid, name, email, passwordHash: hashPassword(input.password), role },
  });
  await setSession(user.id, cid, role);
  return { ok: true, role: appRoleOf(role) };
}

export async function loginUser(input: { email: string; password: string }): Promise<AuthResult> {
  const cid = await companyId();
  if (!cid) return { ok: false, error: "Клиника не настроена" };

  const email = input.email.trim().toLowerCase();
  const user = await prisma.staffUser.findFirst({
    where: { companyId: cid, email, deletedAt: null },
    select: { id: true, passwordHash: true, role: true },
  });
  if (!user || !verifyPassword(input.password, user.passwordHash)) {
    return { ok: false, error: "Неверная почта или пароль" };
  }
  await prisma.staffUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await setSession(user.id, cid, user.role);
  return { ok: true, role: appRoleOf(user.role) };
}

export async function loginAsOwner(): Promise<AuthResult> {
  const cid = await companyId();
  if (!cid) return { ok: false, error: "Клиника не настроена" };

  let owner = await prisma.staffUser.findFirst({
    where: { companyId: cid, role: "OWNER", deletedAt: null },
    select: { id: true },
  });
  // Если владельца ещё нет — заводим (демо-вход без регистрации).
  if (!owner) {
    owner = await prisma.staffUser.create({
      data: { companyId: cid, name: "Владелец", email: `owner@${CLINIC_MAIL_DOMAIN}`, passwordHash: "!invite-pending", role: "OWNER" },
      select: { id: true },
    });
  }
  await setSession(owner.id, cid, "OWNER");
  return { ok: true, role: "owner" };
}

export async function logoutUser(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
