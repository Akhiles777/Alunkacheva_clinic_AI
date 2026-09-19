import { describe, expect, it } from "vitest";
import { fromOurProxy, parseWebhook, verifyChallenge, verifySignature } from "./webhook";
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
  const secret = "секрет-приложения";

  it("верная подпись принимается", () => {
    const sig = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(verifySignature(body, `sha256=${sig}`, secret)).toBe(true);
  });

  it("чужая подпись отклоняется", () => {
    const sig = crypto.createHmac("sha256", "другой").update(body, "utf8").digest("hex");
    expect(verifySignature(body, `sha256=${sig}`, secret)).toBe(false);
  });

  it("мусор вместо подписи — отказ, а не исключение", () => {
    expect(verifySignature(body, "sha256=deadbeef", secret)).toBe(false);
    expect(verifySignature(body, `sha256=${"z".repeat(64)}`, secret)).toBe(false);
    expect(verifySignature(body, null, secret)).toBe(false);
  });

  it("без секрета не принимаем ничего", () => {
    // Открытый вебхук означал бы, что подделать сообщение пациента может кто угодно.
    const sig = crypto.createHmac("sha256", "").update(body, "utf8").digest("hex");
    expect(verifySignature(body, `sha256=${sig}`, "")).toBe(false);
    expect(verifySignature(body, `sha256=${sig}`, null)).toBe(false);
  });
});

describe("подключение вебхука", () => {
  const params = (token: string) =>
    new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "12345" });

  it("возвращает challenge при верном токене", () => {
    expect(verifyChallenge(params("проверка"), "проверка")).toBe("12345");
  });

  it("чужой токен не подтверждается", () => {
    expect(verifyChallenge(params("чужой"), "проверка")).toBeNull();
  });

  it("токен не заведён — не подтверждается ничего, даже пустой", () => {
    expect(verifyChallenge(params(""), "")).toBeNull();
    expect(verifyChallenge(params(""), null)).toBeNull();
  });
});

describe("секрет прокси", () => {
  it("принимается только точное совпадение", () => {
    expect(fromOurProxy("s3cret", "s3cret")).toBe(true);
    expect(fromOurProxy("s3cre", "s3cret")).toBe(false);
    expect(fromOurProxy(null, "s3cret")).toBe(false);
  });

  it("секрет у нас не задан — не принимаем никого", () => {
    expect(fromOurProxy("", "")).toBe(false);
    expect(fromOurProxy("anything", "")).toBe(false);
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
