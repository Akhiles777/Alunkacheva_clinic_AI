import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchUserToken } from "./auth";

/**
 * Проверяем перевод ответов YCLIENTS на человеческий язык. Живой API здесь не
 * дёргается: нам важно, что администратор увидит на экране.
 */
function reply(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe("объяснение ответов YCLIENTS", () => {
  it("нераспознанный партнёрский токен объясняется, а не пересказывается", async () => {
    // Сообщение YCLIENTS звучит так, будто мы что-то не передали, — а значит
    // противоположное: токен передан и не сопоставлен ни с одним партнёром.
    reply(401, { success: false, meta: { message: "Не указан идентификатор партнера" } });
    const r = await fetchUserToken("плохой", "login", "pass");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("не узнаёт партнёрский токен");
    expect(r.error).toContain("активировано");
  });

  it("отсутствие токена ведёт к нужному действию", async () => {
    reply(401, { success: false, meta: { message: "Не указаны авторизационные данные" } });
    const r = await fetchUserToken("", "login", "pass");
    expect(r.error).toContain("партнёрский токен");
  });

  it("неверный пароль назван своим именем", async () => {
    reply(401, { success: false, meta: { message: "Неверный логин или пароль" } });
    const r = await fetchUserToken("t", "login", "pass");
    expect(r.error).toContain("логин или пароль");
  });

  it("успех возвращает токен", async () => {
    reply(200, { success: true, data: { user_token: "abc123" } });
    const r = await fetchUserToken("t", "login", "pass");
    expect(r).toEqual({ ok: true, userToken: "abc123" });
  });

  it("ответ без токена успехом не считается", async () => {
    reply(200, { success: true, data: {} });
    const r = await fetchUserToken("t", "login", "pass");
    expect(r.ok).toBe(false);
  });
});
