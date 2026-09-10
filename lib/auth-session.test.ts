import crypto from "node:crypto";
import { describe, expect, it, vi, afterEach } from "vitest";
import { signSession, verifySession, SESSION_TTL_SEC } from "./auth";

/**
 * Срок сессии проверяется на сервере, а не только куком.
 *
 * Кука — просьба к браузеру, которую можно не исполнить: скопированный токен
 * без срока годен вечно. Для CRM с медицинскими данными это недопустимо.
 */
describe("срок жизни сессии", () => {
  afterEach(() => vi.useRealTimers());

  const payload = { userId: "u1", companyId: "c1", role: "ADMIN" };

  it("свежий токен принимается", () => {
    expect(verifySession(signSession(payload))?.userId).toBe("u1");
  });

  it("срок кладётся в сам токен", () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = verifySession(signSession(payload))?.exp ?? 0;
    expect(exp).toBeGreaterThanOrEqual(now + SESSION_TTL_SEC - 5);
  });

  it("просроченный токен не принимается, хотя подпись верна", () => {
    const token = signSession({ ...payload, exp: Math.floor(Date.now() / 1000) - 1 });
    expect(verifySession(token)).toBeNull();
  });

  it("выпущенный до появления срока принимается: выкатка не выкидывает всех разом", () => {
    // Такой токен подписан тем же ключом, но поля `exp` в нём нет.
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const token = signSession(payload);
    const sig = token.split(".")[1];
    // Пересобираем «старый» токен: тело без exp и его собственная подпись.
    const secret = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
    const oldSig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    expect(sig).not.toBe(oldSig);
    expect(verifySession(`${body}.${oldSig}`)?.userId).toBe("u1");
  });

  it("подделанный токен не принимается", () => {
    const token = signSession(payload);
    const [body] = token.split(".");
    expect(verifySession(`${body}.подпись`)).toBeNull();
  });
});
