import { describe, expect, it, afterEach } from "vitest";
import { parseWebhook, verifyChallenge, verifySignature } from "./webhook";
import { windowOpen } from "./config";
import crypto from "node:crypto";

/** Событие Meta в том виде, в котором оно приходит на вебхук. */
function event(messaging: unknown) {
  return { object: "instagram", entry: [{ id: "17841400000000000", messaging: [messaging] }] };
}

const text = (over: Record<string, unknown> = {}) =>
  event({
    sender: { id: "ig-user-1" },
    recipient: { id: "ig-page-1" },
    message: { mid: "mid.1", text: "Здравствуйте", ...over },
  });

afterEach(() => {
  delete process.env.INSTAGRAM_APP_SECRET;
  delete process.env.INSTAGRAM_VERIFY_TOKEN;
});

describe("разбор сообщений Instagram", () => {
  it("обычное сообщение разбирается", () => {
    const [e] = parseWebhook(text());
    expect(e.kind).toBe("message");
    if (e.kind !== "message") return;
    expect(e.externalId).toBe("mid.1");
    expect(e.senderId).toBe("ig-user-1");
    expect(e.text).toBe("Здравствуйте");
  });

  it("эхо собственной отправки игнорируется", () => {
    // Иначе агент ответит на собственную реплику и уйдёт во второй круг.
    const [e] = parseWebhook(text({ is_echo: true }));
    expect(e.kind).toBe("ignored");
  });

  it("удалённое пациентом сообщение не обрабатывается", () => {
    const [e] = parseWebhook(text({ is_deleted: true }));
    expect(e.kind).toBe("ignored");
  });

  it("отметка о прочтении и реакция — не сообщения", () => {
    expect(parseWebhook(event({ sender: { id: "u" }, read: { mid: "m" } }))[0].kind).toBe("ignored");
    expect(parseWebhook(event({ sender: { id: "u" }, reaction: { mid: "m" } }))[0].kind).toBe("ignored");
  });

  it("вложение сохраняет ссылку и не становится пустым сообщением", () => {
    const [e] = parseWebhook(
      event({
        sender: { id: "ig-user-1" },
        message: { mid: "mid.2", attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }] },
      }),
    );
    expect(e.kind).toBe("message");
    if (e.kind !== "message") return;
    expect(e.text).toContain("фотография");
    expect(e.attachments).toHaveLength(1);
  });

  it("сообщение без идентификатора отбрасывается", () => {
    const [e] = parseWebhook(event({ sender: { id: "u" }, message: { text: "привет" } }));
    expect(e.kind).toBe("ignored");
  });

  it("мусор не роняет разбор", () => {
    expect(parseWebhook({ hello: "world" })[0].kind).toBe("ignored");
    expect(parseWebhook(null)[0].kind).toBe("ignored");
  });
});

describe("подпись Meta", () => {
  const body = '{"object":"instagram"}';

  it("верная подпись принимается", () => {
    process.env.INSTAGRAM_APP_SECRET = "секрет-приложения";
    const sig = crypto.createHmac("sha256", "секрет-приложения").update(body, "utf8").digest("hex");
    expect(verifySignature(body, `sha256=${sig}`)).toBe(true);
  });

  it("чужая подпись отклоняется", () => {
    process.env.INSTAGRAM_APP_SECRET = "секрет-приложения";
    const sig = crypto.createHmac("sha256", "другой", ).update(body, "utf8").digest("hex");
    expect(verifySignature(body, `sha256=${sig}`)).toBe(false);
  });

  it("без секрета не принимаем ничего", () => {
    // Открытый вебхук означал бы, что подделать сообщение пациента может кто угодно.
    expect(verifySignature(body, "sha256=deadbeef")).toBe(false);
  });
});

describe("подключение вебхука", () => {
  it("возвращает challenge при верном токене", () => {
    process.env.INSTAGRAM_VERIFY_TOKEN = "проверка";
    const p = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "проверка", "hub.challenge": "12345" });
    expect(verifyChallenge(p)).toBe("12345");
  });

  it("чужой токен не подтверждается", () => {
    process.env.INSTAGRAM_VERIFY_TOKEN = "проверка";
    const p = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "чужой", "hub.challenge": "12345" });
    expect(verifyChallenge(p)).toBeNull();
  });
});

describe("окно ответа 24 часа", () => {
  const now = new Date("2026-08-14T12:00:00.000Z");

  it("свежее сообщение — окно открыто", () => {
    expect(windowOpen(new Date("2026-08-14T11:00:00.000Z"), now)).toBe(true);
  });

  it("сутки прошли — окно закрыто", () => {
    // Ответ вне окна Meta отклоняет, и со стороны это выглядит как молчащий бот.
    expect(windowOpen(new Date("2026-08-13T11:00:00.000Z"), now)).toBe(false);
  });

  it("пациент не писал — окна нет", () => {
    expect(windowOpen(null, now)).toBe(false);
  });
});
