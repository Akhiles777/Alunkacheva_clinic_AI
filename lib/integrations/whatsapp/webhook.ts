import { z } from "zod";
import { isGroupChat, phoneFromChatId } from "./chat-id";

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
    .object({ downloadUrl: z.string(), caption: z.string(), fileName: z.string() })
    .partial()
    .optional(),
  locationMessageData: z.object({ nameLocation: z.string() }).partial().optional(),
  contactMessageData: z.object({ displayName: z.string() }).partial().optional(),
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
    }
  | { kind: "status"; externalId: string; status: string }
  | { kind: "state"; state: string }
  | { kind: "ignored"; reason: string };

/** Подписи вместо содержимого для нетекстовых сообщений. */
const MEDIA_LABEL: Record<string, string> = {
  imageMessage: "прислал изображение",
  videoMessage: "прислал видео",
  documentMessage: "прислал документ",
  audioMessage: "прислал голосовое сообщение",
  stickerMessage: "прислал стикер",
  locationMessage: "прислал геопозицию",
  contactMessage: "прислал контакт",
  pollMessage: "прислал опрос",
};

export function parseWebhook(raw: unknown): ParsedEvent {
  const parsed = GreenWebhookSchema.safeParse(raw);
  if (!parsed.success) return { kind: "ignored", reason: "не разобрано" };
  const e = parsed.data;

  switch (e.typeWebhook) {
    case "incomingMessageReceived":
      return parseMessage(e);

    /**
     * Наши же исходящие, вернувшиеся эхом. Сохранять их как сообщение
     * пациента нельзя: агент увидел бы собственный ответ как новый вопрос и
     * ушёл во второй круг.
     */
    case "outgoingMessageReceived":
    case "outgoingAPIMessageReceived":
      return { kind: "ignored", reason: "собственное исходящее сообщение" };

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

  const mediaLabel = MEDIA_LABEL[type];
  const isMedia = Boolean(mediaLabel) || (type !== "textMessage" && type !== "extendedTextMessage");

  /**
   * У нетекстового сообщения показываем подпись, а не пустую строку: пустое
   * сообщение в переписке выглядит как сбой платформы, хотя пациент просто
   * прислал фотографию.
   */
  const body = text.trim() || (isMedia ? `[${mediaLabel ?? "прислал вложение"}]` : "");
  if (!body) return { kind: "ignored", reason: "пустое сообщение" };

  return {
    kind: "message",
    externalId: e.idMessage,
    chatId,
    phoneE164: phoneFromChatId(chatId),
    senderName: e.senderData?.senderName?.trim() || null,
    text: body.slice(0, 4000),
    isMedia,
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
