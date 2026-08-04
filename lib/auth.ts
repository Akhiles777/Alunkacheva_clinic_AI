import crypto from "node:crypto";

/**
 * Аутентификация: хэширование паролей (scrypt) и подписанные сессионные куки
 * (HMAC). Без внешних зависимостей — только node:crypto. Секрет — из env.
 */
/**
 * Секрет подписи сессии. Читается лениво, при первой подписи или проверке.
 *
 * Не на уровне модуля: сборка Next импортирует все страницы («Collecting page
 * data»), а переменных окружения на этом шаге нет — бросок при импорте валит
 * билд ещё до деплоя. Проверка нужна, но её место — первый реальный вызов.
 *
 * В продакшене отсутствие секрета — не мелочь: с известным значением куку
 * подделает кто угодно и войдёт владельцем. Поэтому там падаем с понятным
 * текстом, а не работаем «как-нибудь».
 */
let cachedSecret: string | null = null;

function secret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.SESSION_SECRET || process.env.CREDENTIAL_MASTER_KEY;
  if (fromEnv && fromEnv.length >= 16) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Не задан SESSION_SECRET (минимум 16 символов). Сгенерировать: openssl rand -base64 32",
    );
  }
  cachedSecret = "dev-insecure-secret-change-me";
  return cachedSecret;
}

export const SESSION_COOKIE = "mera_session";

/**
 * Логин сотрудника: латиница, цифры, точка, дефис, подчёркивание, 3–30 знаков.
 * Почту не требуем — клиника заводит людей вручную, и у медсестры адреса может
 * не быть. Кириллицу не пускаем: логин набирают в спешке, а раскладка подводит.
 */
export const LOGIN_RE = /^[a-z0-9._-]{3,30}$/;

export function normalizeLogin(raw: string): string {
  return raw.trim().toLowerCase();
}
export const INVITE_PENDING = "!invite-pending"; // засеянные учётки без пароля

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!stored || stored === INVITE_PENDING) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(test, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface SessionPayload {
  userId: string;
  companyId: string;
  role: string;
}

export function signSession(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token: string): SessionPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
  } catch {
    return null;
  }
}
