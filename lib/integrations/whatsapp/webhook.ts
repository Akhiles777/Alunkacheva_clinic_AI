import { z } from "zod";
import { isGroupChat, phoneFromChatId } from "./chat-id";
import { KIND_LABEL, type AttachmentKind, type IncomingAttachment } from "@/lib/agent/attachments";

/**
 * Разбор вебхуков Green API.
 *
 * Провайдер шлёт в один адрес разнородные события: входящие сообщения,
 * статусы доставки, отправленные нами же сообщения, изменения состояния
 * инстанса и звонки. Принять их за одно — самая частая ошибка при подключении:
 * тогда статус «доставлено» превращается в сообщение пациента, а собственный
 * ответ бота прилетает обратно и запускает второй круг ответа.
 *
 * Разбор — чистая функция без обращений к базе, чтобы его можно было
 * проверить тестами до всякого подключения (§11).
 */

const SenderData = z.object({
  chatId: z.string(),
  sender: z.string().optional(),
  senderName: z.string().optional(),
  chatName: z.string().optional(),
});

/**
 * Тело сообщения. Полей у Green API много и они разные для каждого типа;
 * описываем только то, что используем, остальное игнорируем.
 */
const MessageData = z.object({
  typeMessage: z.string().optional(),
  textMessageData: z.object({ textMessage: z.string() }).partial().optional(),
  extendedTextMessageData: z
    .object({ text: z.string(), description: z.string() })
    .partial()
    .optional(),
  fileMessageData: z
    .object({
      downloadUrl: z.string(),
      caption: z.string(),
      fileName: z.string(),
      mimeType: z.string(),
    })
    .partial()
    .optional(),
  locationMessageData: z.object({ nameLocation: z.string() }).partial().optional(),
  contactMessageData: z.object({ displayName: z.string() }).partial().optional(),
  /**
   * Ответ на конкретное сообщение — то, что в WhatsApp делают свайпом.
   *
   * Провайдер присылает такое сообщение с типом quotedMessage, и раньше оно
   * не подходило ни под один известный тип: платформа считала его вложением и
   * писала в переписку «[вложение]». Ответ пациента на конкретную реплику
   * выглядел как присланный неизвестный файл — ни текста, ни того, на что
   * отвечали.
   */
  quotedMessage: z
    .object({
      stanzaId: z.string(),
      participant: z.string(),
      typeMessage: z.string(),
      textMessage: z.string(),
      caption: z.string(),
    })
    .partial()
    .optional(),
});

export const GreenWebhookSchema = z.object({
  typeWebhook: z.string(),
  instanceData: z.object({ idInstance: z.union([z.number(), z.string()]) }).partial().optional(),
  timestamp: z.number().optional(),
  idMessage: z.string().optional(),
  senderData: SenderData.optional(),
  messageData: MessageData.optional(),
  // Статусы доставки: sent / delivered / read / failed / noAccount.
  status: z.string().optional(),
  stateInstance: z.string().optional(),
});
export type GreenWebhook = z.infer<typeof GreenWebhookSchema>;

/** Что именно пришло — в терминах, понятных бизнес-логике. */
export type ParsedEvent =
  | {
      kind: "message";
      /** Идентификатор у провайдера: по нему обеспечивается идемпотентность. */
      externalId: string;
      chatId: string;
      phoneE164: string | null;
      senderName: string | null;
      text: string;
      /** Не текст: фото, голосовое, документ, геометка, контакт. */
      isMedia: boolean;
      /** Файлы сообщения: по ним администратор откроет голосовое или снимок. */
      attachments: IncomingAttachment[];
    }
  /**
   * Наше же исходящее, но отправленное не платформой: администратор ответил
   * пациенту прямо в WhatsApp на телефоне. Такое сообщение надо сохранить и
   * замолчать боту — иначе он продолжит говорить поверх живого человека.
   */
  | {
      kind: "outgoing";
      externalId: string;
      chatId: string;
      phoneE164: string | null;
      text: string;
      attachments: IncomingAttachment[];
    }
  | { kind: "status"; externalId: string; status: string }
  | { kind: "state"; state: string }
  | { kind: "ignored"; reason: string };

/**
 * Типы Green API → наши виды вложений.
 *
 * Раньше здесь были только подписи, а ссылка на файл выбрасывалась: в
 * переписке появлялось «[прислал голосовое сообщение]», и послушать его было
 * нечем. Теперь тип нужен и для подписи, и для того, чтобы открыть файл.
 */
const KIND_BY_TYPE: Record<string, AttachmentKind> = {
  imageMessage: "photo",
  videoMessage: "video",
  documentMessage: "document",
  audioMessage: "voice",
  voiceMessage: "voice",
  pttMessage: "voice",
  stickerMessage: "sticker",
  locationMessage: "location",
  contactMessage: "contact",
};

export function parseWebhook(raw: unknown): ParsedEvent {
  const parsed = GreenWebhookSchema.safeParse(raw);
  if (!parsed.success) return { kind: "ignored", reason: "не разобрано" };
  const e = parsed.data;

  switch (e.typeWebhook) {
    case "incomingMessageReceived":
      return parseMessage(e);

    /**
     * Отправленное нами же через API: платформа уже сохранила это сообщение
     * при отправке. Второй раз записывать нельзя, а принять за вопрос
     * пациента — тем более: агент ушёл бы во второй круг.
     */
    case "outgoingAPIMessageReceived":
      return { kind: "ignored", reason: "собственное исходящее сообщение" };

    /**
     * Отправленное с телефона. Это ответ администратора, набранный прямо в
     * WhatsApp, а не через платформу. Прежде оно выбрасывалось вместе с нашим
     * эхом — и получалось, что человек уже разговаривает с пациентом, а бот
     * об этом не знает и продолжает отвечать поверх него (§6.4).
     */
    case "outgoingMessageReceived":
      return parseOutgoing(e);

    case "outgoingMessageStatus":
      return e.idMessage
        ? { kind: "status", externalId: e.idMessage, status: e.status ?? "unknown" }
        : { kind: "ignored", reason: "статус без идентификатора" };

    case "stateInstanceChanged":
      return { kind: "state", state: e.stateInstance ?? "unknown" };

    /**
     * Звонок в WhatsApp платформа не принимает: отвечать на него некому, а
     * пропущенный звонок администратор увидит на телефоне клиники.
     */
    case "incomingCall":
      return { kind: "ignored", reason: "входящий звонок" };

    default:
      return { kind: "ignored", reason: `неизвестный тип: ${e.typeWebhook}` };
  }
}

/** Ответ администратора, набранный в WhatsApp на телефоне. */
function parseOutgoing(e: GreenWebhook): ParsedEvent {
  const inner = parseMessage(e);
  if (inner.kind !== "message") return inner;
  return {
    kind: "outgoing",
    externalId: inner.externalId,
    chatId: inner.chatId,
    phoneE164: inner.phoneE164,
    text: inner.text,
    attachments: inner.attachments,
  };
}

/** Типы, у которых есть собственный текст: вложением их считать нельзя. */
const TEXT_TYPES = new Set(["textMessage", "extendedTextMessage", "quotedMessage"]);

/** Сколько знаков цитаты показываем: она подсказка, а не сообщение. */
const QUOTE_LIMIT = 120;

/**
 * Строка «В ответ на: …», если пациент отвечал на конкретное сообщение.
 *
 * У цитаты может не быть текста — отвечали на фотографию или голосовое. Тогда
 * называем тип: понять, к чему относится ответ, всё равно важнее, чем ничего.
 */
function quotedText(e: GreenWebhook): string | null {
  const q = e.messageData?.quotedMessage;
  if (!q) return null;

  const text = (q.textMessage ?? q.caption ?? "").trim();
  if (text) {
    const short = text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text;
    return `В ответ на: «${short}»`;
  }

  const kind = q.typeMessage ? KIND_BY_TYPE[q.typeMessage] : undefined;
  return kind ? `В ответ на: ${KIND_LABEL[kind]}` : "В ответ на сообщение";
}

function parseMessage(e: GreenWebhook): ParsedEvent {
  const chatId = e.senderData?.chatId;
  if (!chatId) return { kind: "ignored", reason: "нет chatId" };

  /**
   * Группы и статусы не обслуживаем: в группе нет одного пациента, а ответ
   * ушёл бы всем участникам. Рассылки (status@broadcast) — тем более.
   */
  if (isGroupChat(chatId)) return { kind: "ignored", reason: "групповой чат или рассылка" };
  if (!e.idMessage) return { kind: "ignored", reason: "сообщение без идентификатора" };

  const type = e.messageData?.typeMessage ?? "";
  const text =
    e.messageData?.textMessageData?.textMessage ??
    e.messageData?.extendedTextMessageData?.text ??
    e.messageData?.fileMessageData?.caption ??
    "";

  const kind = KIND_BY_TYPE[type];
  // Текстовые типы: обычное сообщение, сообщение со ссылкой и ответ на реплику.
  const isMedia = Boolean(kind) || !TEXT_TYPES.has(type);

  const attachments: IncomingAttachment[] = [];
  if (isMedia) {
    const file = e.messageData?.fileMessageData;
    const at: AttachmentKind = kind ?? "other";
    attachments.push({
      kind: at,
      label: KIND_LABEL[at],
      // Ссылка Green API долгоживущая и токена не содержит — храним как есть.
      // Нет ссылки (геопозиция, контакт) — остаётся одна подпись.
      source: file?.downloadUrl ? { provider: "WHATSAPP", url: file.downloadUrl } : { provider: "NONE" },
      mimeType: file?.mimeType,
      fileName: file?.fileName,
    });
  }

  /**
   * У нетекстового сообщения показываем подпись, а не пустую строку: пустое
   * сообщение в переписке выглядит как сбой платформы, хотя пациент просто
   * прислал фотографию.
   */
  const caption = text.trim();
  const marks = attachments.map((a) => `[${a.label}]`).join(" ");
  const withMarks = caption && marks ? `${marks} ${caption}` : caption || marks;

  /**
   * На что отвечал пациент. Без этой строки ответ свайпом читается как реплика
   * невпопад: «да» само по себе не говорит ни администратору, ни агенту, к
   * чему оно относится.
   */
  const quoted = quotedText(e);
  const body = quoted ? `${quoted}\n${withMarks}` : withMarks;
  if (!body.trim()) return { kind: "ignored", reason: "пустое сообщение" };

  return {
    kind: "message",
    externalId: e.idMessage,
    chatId,
    phoneE164: phoneFromChatId(chatId),
    senderName: e.senderData?.senderName?.trim() || null,
    text: body.slice(0, 4000),
    isMedia,
    attachments,
  };
}

/**
 * Проверка секрета вебхука.
 *
 * Green API не подписывает вебхуки, но позволяет задать токен авторизации в
 * настройках инстанса — он приходит заголовком Authorization: Bearer.
 * Незаданный секрет означает «не настроено» и закрывает вход: открытый адрес
 * вебхука позволил бы кому угодно писать в инбокс клиники от имени пациента.
 */
export function verifyWebhookSecret(header: string | null | undefined): boolean {
  const expected = process.env.GREEN_API_WEBHOOK_SECRET ?? "";
  if (!expected) return false;
  const provided = (header ?? "").replace(/^Bearer\s+/i, "").trim();
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
