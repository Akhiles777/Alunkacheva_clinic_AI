import { describe, expect, it } from "vitest";
import { parseWebhook, verifyWebhookSecret } from "./webhook";
import { chatIdFromPhone, isGroupChat, phoneFromChatId } from "./chat-id";

/**
 * Green API шлёт в один адрес разнородные события. Принять их за одно —
 * самая частая ошибка при подключении: статус «доставлено» превращается в
 * сообщение пациента, а собственный ответ бота прилетает обратно и запускает
 * второй круг ответа.
 */
const incoming = (over: Record<string, unknown> = {}) => ({
  typeWebhook: "incomingMessageReceived",
  idMessage: "ABC123",
  timestamp: 1786600000,
  senderData: { chatId: "79991234567@c.us", senderName: "Иван" },
  messageData: { typeMessage: "textMessage", textMessageData: { textMessage: "Здравствуйте" } },
  ...over,
});

describe("разбор входящего сообщения", () => {
  it("текст пациента разбирается полностью", () => {
    const e = parseWebhook(incoming());
    expect(e.kind).toBe("message");
    if (e.kind !== "message") return;
    expect(e.externalId).toBe("ABC123");
    expect(e.phoneE164).toBe("+79991234567");
    expect(e.senderName).toBe("Иван");
    expect(e.text).toBe("Здравствуйте");
    expect(e.isMedia).toBe(false);
  });

  it("длинный текст с цитатой берётся из extendedTextMessage", () => {
    const e = parseWebhook(
      incoming({
        messageData: {
          typeMessage: "extendedTextMessage",
          extendedTextMessageData: { text: "А сколько стоит?" },
        },
      }),
    );
    expect(e.kind === "message" && e.text).toBe("А сколько стоит?");
  });

  it("фотография не становится пустым сообщением", () => {
    const e = parseWebhook(
      incoming({ messageData: { typeMessage: "imageMessage", fileMessageData: {} } }),
    );
    expect(e.kind).toBe("message");
    if (e.kind !== "message") return;
    expect(e.isMedia).toBe(true);
    expect(e.text).toContain("изображение");
  });

  it("подпись к файлу важнее ярлыка", () => {
    const e = parseWebhook(
      incoming({
        messageData: { typeMessage: "imageMessage", fileMessageData: { caption: "Вот мой анализ" } },
      }),
    );
    expect(e.kind === "message" && e.text).toBe("Вот мой анализ");
  });
});

describe("что обрабатывать нельзя", () => {
  it("групповой чат игнорируется: ответ ушёл бы всем участникам", () => {
    const e = parseWebhook(incoming({ senderData: { chatId: "79991234567-1234@g.us" } }));
    expect(e.kind).toBe("ignored");
  });

  it("рассылка статусов игнорируется", () => {
    const e = parseWebhook(incoming({ senderData: { chatId: "status@broadcast" } }));
    expect(e.kind).toBe("ignored");
  });

  it("собственное исходящее не считается сообщением пациента", () => {
    for (const t of ["outgoingMessageReceived", "outgoingAPIMessageReceived"]) {
      expect(parseWebhook(incoming({ typeWebhook: t })).kind, t).toBe("ignored");
    }
  });

  it("статус доставки — не сообщение", () => {
    const e = parseWebhook({ typeWebhook: "outgoingMessageStatus", idMessage: "X1", status: "delivered" });
    expect(e).toEqual({ kind: "status", externalId: "X1", status: "delivered" });
  });

  it("смена состояния инстанса распознаётся отдельно", () => {
    const e = parseWebhook({ typeWebhook: "stateInstanceChanged", stateInstance: "notAuthorized" });
    expect(e).toEqual({ kind: "state", state: "notAuthorized" });
  });

  it("входящий звонок игнорируется", () => {
    expect(parseWebhook({ typeWebhook: "incomingCall" }).kind).toBe("ignored");
  });

  it("сообщение без идентификатора не принимается: нечем защититься от повтора", () => {
    expect(parseWebhook(incoming({ idMessage: undefined })).kind).toBe("ignored");
  });

  it("мусор и пустое тело не роняют разбор", () => {
    expect(parseWebhook(null).kind).toBe("ignored");
    expect(parseWebhook({}).kind).toBe("ignored");
    expect(parseWebhook({ typeWebhook: "somethingNew" }).kind).toBe("ignored");
  });
});

describe("адрес WhatsApp и телефон", () => {
  it("chatId переводится в E.164", () => {
    expect(phoneFromChatId("79991234567@c.us")).toBe("+79991234567");
  });

  it("телефон в любом написании даёт один chatId", () => {
    for (const p of ["+7 999 123-45-67", "8 (999) 123 45 67", "+79991234567"]) {
      expect(chatIdFromPhone(p), p).toBe("79991234567@c.us");
    }
  });

  it("группа не даёт телефона", () => {
    expect(phoneFromChatId("79991234567-1234@g.us")).toBeNull();
    expect(isGroupChat("79991234567-1234@g.us")).toBe(true);
  });

  it("мусор не превращается в номер", () => {
    expect(phoneFromChatId("abc@c.us")).toBeNull();
    expect(phoneFromChatId(null)).toBeNull();
    expect(chatIdFromPhone("позвоните позже")).toBeNull();
  });
});

describe("секрет вебхука", () => {
  it("без заданного секрета вход закрыт", () => {
    delete process.env.GREEN_API_WEBHOOK_SECRET;
    expect(verifyWebhookSecret("Bearer что-угодно")).toBe(false);
  });

  it("совпадающий секрет принимается, в том числе с префиксом Bearer", () => {
    process.env.GREEN_API_WEBHOOK_SECRET = "s3cret-token";
    expect(verifyWebhookSecret("s3cret-token")).toBe(true);
    expect(verifyWebhookSecret("Bearer s3cret-token")).toBe(true);
    expect(verifyWebhookSecret("другой")).toBe(false);
    expect(verifyWebhookSecret(null)).toBe(false);
    delete process.env.GREEN_API_WEBHOOK_SECRET;
  });
});
