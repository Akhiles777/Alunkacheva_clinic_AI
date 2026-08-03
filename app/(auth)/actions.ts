"use server";

import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { hashPassword, SESSION_COOKIE, signSession, verifyPassword } from "@/lib/auth";
import { appRoleOf, type AppRole } from "@/lib/roles";
import type { StaffRole } from "@/generated/prisma/enums";

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

export async function registerUser(input: { name: string; email: string; password: string }): Promise<AuthResult> {
  const cid = await companyId();
  if (!cid) return { ok: false, error: "Клиника не настроена" };

  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (name.length < 2) return { ok: false, error: "Укажите имя" };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Проверьте почту" };
  if (input.password.length < 6) return { ok: false, error: "Пароль не короче 6 символов" };

  const exists = await prisma.staffUser.findFirst({ where: { companyId: cid, email }, select: { id: true } });
  if (exists) return { ok: false, error: "Пользователь с такой почтой уже есть" };

  const user = await prisma.staffUser.create({
    data: { companyId: cid, name, email, passwordHash: hashPassword(input.password), role: "ADMIN" },
  });
  await setSession(user.id, cid, "ADMIN");
  return { ok: true, role: "admin" };
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
      data: { companyId: cid, name: "Владелец", email: "owner@mera.clinic", passwordHash: "!invite-pending", role: "OWNER" },
      select: { id: true },
    });
  }
  await setSession(owner.id, cid, "OWNER");
  return { ok: true, role: "owner" };
}

export async function logoutUser(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
