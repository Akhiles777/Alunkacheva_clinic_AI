import crypto from "node:crypto";
import { z } from "zod";
import { KIND_LABEL, type AttachmentKind, type IncomingAttachment } from "@/lib/agent/attachments";

/**
 * Разбор вебхуков Instagram Messaging.
 *
 * Meta шлёт в один адрес разнородные события: входящие сообщения, эхо наших
 * же отправок, отметки о прочтении, реакции. Разбираем то, на что реагируем, и
 * честно называем причину для остального — молчаливое «ignored» однажды уже
 * стоило потерянных сообщений в WhatsApp.
 */

const Attachment = z.object({
  type: z.string(),
  payload: z.object({ url: z.string() }).partial().optional(),
});

const Messaging = z.object({
  sender: z.object({ id: z.string() }).partial().optional(),
  recipient: z.object({ id: z.string() }).partial().optional(),
  timestamp: z.number().optional(),
  message: z
    .object({
      mid: z.string(),
      text: z.string(),
      /** Наше же отправленное, вернувшееся эхом. */
      is_echo: z.boolean(),
      is_deleted: z.boolean(),
      attachments: z.array(Attachment),
    })
    .partial()
    .optional(),
  read: z.object({ mid: z.string() }).partial().optional(),
  reaction: z.object({ mid: z.string() }).partial().optional(),
});

export const InstagramWebhookSchema = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        id: z.string().optional(),
        time: z.number().optional(),
        messaging: z.array(Messaging).optional(),
      }),
    )
    .optional(),
});

export type ParsedInstagramEvent =
  | {
      kind: "message";
      /** Идентификатор сообщения у Meta: по нему обеспечивается идемпотентность. */
      externalId: string;
      /** Идентификатор пользователя в переписке (IGSID). Телефона здесь нет. */
      senderId: string;
      text: string;
      attachments: IncomingAttachment[];
    }
  | { kind: "ignored"; reason: string };

/** Типы вложений Meta → наши виды. */
const KIND_BY_TYPE: Record<string, AttachmentKind> = {
  image: "photo",
  video: "video",
  audio: "voice",
  file: "document",
  story_mention: "other",
  share: "other",
};

/**
 * Разбирает одно событие. Meta присылает пачку, но за раз нас интересует
 * первое сообщение: остальные приходят отдельными вызовами вебхука.
 */
export function parseWebhook(raw: unknown): ParsedInstagramEvent[] {
  const parsed = InstagramWebhookSchema.safeParse(raw);
  if (!parsed.success) return [{ kind: "ignored", reason: "не разобрано" }];

  const out: ParsedInstagramEvent[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      out.push(parseOne(m));
    }
  }
  return out.length > 0 ? out : [{ kind: "ignored", reason: "нет событий переписки" }];
}

function parseOne(m: z.infer<typeof Messaging>): ParsedInstagramEvent {
  if (m.read) return { kind: "ignored", reason: "отметка о прочтении" };
  if (m.reaction) return { kind: "ignored", reason: "реакция на сообщение" };

  const msg = m.message;
  if (!msg) return { kind: "ignored", reason: "событие без сообщения" };

  /**
   * Эхо собственных отправок. Принять его за вопрос пациента значит уйти во
   * второй круг: агент ответит на собственную реплику.
   */
  if (msg.is_echo) return { kind: "ignored", reason: "собственное исходящее сообщение" };
  if (msg.is_deleted) return { kind: "ignored", reason: "сообщение удалено отправителем" };
  if (!msg.mid) return { kind: "ignored", reason: "сообщение без идентификатора" };

  const senderId = m.sender?.id;
  if (!senderId) return { kind: "ignored", reason: "нет отправителя" };

  const attachments: IncomingAttachment[] = (msg.attachments ?? []).map((a) => {
    const kind = KIND_BY_TYPE[a.type] ?? "other";
    return {
      kind,
      label: KIND_LABEL[kind],
      // Ссылка Meta живёт ограниченное время и открыта по секрету в адресе —
      // храним как есть, отдаём только вошедшему сотруднику через /api/media.
      source: a.payload?.url ? { provider: "WHATSAPP", url: a.payload.url } : { provider: "NONE" },
    };
  });

  const caption = (msg.text ?? "").trim();
  const marks = attachments.map((a) => `[${a.label}]`).join(" ");
  const body = caption && marks ? `${marks} ${caption}` : caption || marks;
  if (!body) return { kind: "ignored", reason: "пустое сообщение" };

  return {
    kind: "message",
    externalId: msg.mid,
    senderId,
    text: body.slice(0, 4000),
    attachments,
  };
}

/**
 * Подпись Meta: HMAC-SHA256 тела запроса секретом приложения.
 *
 * Проверяем именно тело, а не разобранный объект: пересобранный JSON отличается
 * от исходного пробелами и порядком ключей, и подпись бы не сошлась.
 * Сравнение — постоянное по времени: обычное сравнение строк подсказывает
 * длину совпавшего префикса.
 */
export function verifySignature(rawBody: string, header: string | null | undefined): boolean {
  const secret = process.env.INSTAGRAM_APP_SECRET ?? "";
  if (!secret) return false;

  const provided = (header ?? "").replace(/^sha256=/i, "").trim();
  if (!provided) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}

/**
 * Проверка адреса при подключении вебхука: Meta присылает GET с токеном,
 * который мы задали в настройках приложения, и ждёт обратно challenge.
 */
export function verifyChallenge(params: URLSearchParams): string | null {
  const token = process.env.INSTAGRAM_VERIFY_TOKEN ?? "";
  if (!token) return null;
  if (params.get("hub.mode") !== "subscribe") return null;
  if (params.get("hub.verify_token") !== token) return null;
  return params.get("hub.challenge");
}
