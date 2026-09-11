"use server";

import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/db";
import { hashPassword, LOGIN_RE, normalizeLogin, SESSION_COOKIE, signSession, verifyPassword } from "@/lib/auth";
import { appRoleOf, type AppRole } from "@/lib/roles";
import type { StaffRole } from "@/generated/prisma/enums";
import { writeAudit } from "@/lib/server/audit";
import { getSessionOrNull } from "@/lib/server/session";
import { parseDevice } from "@/lib/metrics/device";

/**
 * Вход и регистрация. Входа «без пароля» нет: прежняя кнопка «Войти как
 * владелец» пускала владельцем любого, кто открыл страницу входа, — для CRM с
 * медицинскими данными это дыра. Пароли хэшируются (scrypt), сессия —
 * подписанная кука.
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

export async function registerUser(input: { name: string; login: string; password: string }): Promise<AuthResult> {
  const cid = await companyId();
  if (!cid) return { ok: false, error: "Клиника не настроена" };

  const name = input.name.trim();
  const login = normalizeLogin(input.login);
  if (name.length < 2) return { ok: false, error: "Укажите имя" };
  if (!LOGIN_RE.test(login)) {
    return { ok: false, error: "Логин: латиница, цифры, точка, дефис — от 3 до 30 знаков" };
  }
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
  const exists = await prisma.staffUser.findFirst({ where: { companyId: cid, login }, select: { id: true } });
  if (exists) return { ok: false, error: "Такой логин уже занят" };

  // Первый сотрудник свежей установки — владелец: иначе некому раздать доступы.
  const role = bootstrap ? "OWNER" : "ADMIN";
  const user = await prisma.staffUser.create({
    data: { companyId: cid, name, login, passwordHash: hashPassword(input.password), role },
  });
  await setSession(user.id, cid, role);
  return { ok: true, role: appRoleOf(role) };
}

/**
 * Запомнить устройство, с которого вошли.
 *
 * Ровно одно обращение к базе и только при входе. Модели аппарата в строке
 * браузера нет — ни у Mac, ни у iPhone (см. `lib/metrics/device.ts`), поэтому
 * подпись честно ограничена системой и браузером, а различает устройства
 * отпечаток.
 */
async function rememberDevice(companyId: string, userId: string): Promise<void> {
  const ua = (await headers()).get("user-agent")?.slice(0, 300) ?? "";
  if (!ua) return;
  const d = parseDevice(ua);
  await prisma.knownDevice.upsert({
    where: {
      companyId_userId_fingerprint: { companyId, userId, fingerprint: d.fingerprint },
    },
    update: { lastLoginAt: new Date(), logins: { increment: 1 }, userAgent: ua, label: d.label },
    create: {
      companyId,
      userId,
      fingerprint: d.fingerprint,
      userAgent: ua,
      label: d.label,
      platform: d.platform,
      browser: d.browser,
      kind: d.kind,
      logins: 1,
    },
  });
}

export async function loginUser(input: { login: string; password: string }): Promise<AuthResult> {
  const cid = await companyId();
  if (!cid) return { ok: false, error: "Клиника не настроена" };

  const login = normalizeLogin(input.login);
  const user = await prisma.staffUser.findFirst({
    where: { companyId: cid, login, deletedAt: null },
    select: { id: true, passwordHash: true, role: true },
  });
  if (!user || !verifyPassword(input.password, user.passwordHash)) {
    return { ok: false, error: "Неверный логин или пароль" };
  }
  await prisma.staffUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await setSession(user.id, cid, user.role);
  // Устройство — один upsert на вход. Входят редко, на скорость работы это не
  // влияет никак; «что делали» берётся из журнала аудита и второй записи не
  // требует.
  await rememberDevice(cid, user.id).catch(() => {
    // Учёт устройств не должен мешать войти в систему.
  });
  // Вход фиксируем в журнале: без него нельзя ответить, кто и с какого
  // устройства работал в системе — а это первый вопрос при разборе.
  await writeAudit({
    companyId: cid,
    actorId: user.id,
    action: "LOGIN",
    entityType: "session",
  }).catch(() => {});
  return { ok: true, role: appRoleOf(user.role) };
}

export async function logoutUser(): Promise<void> {
  const session = await getSessionOrNull();
  if (session?.userId) {
    await writeAudit({
      companyId: session.companyId,
      actorId: session.userId,
      action: "LOGOUT",
      entityType: "session",
    }).catch(() => {});
  }
  (await cookies()).delete(SESSION_COOKIE);
}
