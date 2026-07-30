import crypto from "node:crypto";

/**
 * Аутентификация: хэширование паролей (scrypt) и подписанные сессионные куки
 * (HMAC). Без внешних зависимостей — только node:crypto. Секрет — из env.
 */
const SECRET =
  process.env.SESSION_SECRET || process.env.CREDENTIAL_MASTER_KEY || "dev-insecure-secret-change-me";

export const SESSION_COOKIE = "mera_session";
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
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token: string): SessionPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
  } catch {
    return null;
  }
}
