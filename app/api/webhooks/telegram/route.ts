import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { handlePatientMessage } from "@/lib/agent/clinic-agent";
import { runSerial } from "@/lib/server/background";
import { markDelivery } from "@/lib/agent/unanswered";
import {
  answerCallback,
  isTelegramConfigured,
  removeKeyboard,
  requestPhone,
  sendText,
} from "@/lib/integrations/telegram/client";
import { attachmentsFrom, TelegramAttachmentFields } from "@/lib/integrations/telegram/attachments";

/**
 * Вебхук Telegram.
 *
 * Отвечаем 200 всегда и как можно быстрее: на любой другой код Telegram
 * повторяет доставку, и пациент получает дубли ответов. Ошибки обработки
 * гасим внутри.
 *
 * Подлинность проверяем секретом в заголовке (secret_token из setWebhook) —
 * URL вебхука сам по себе не секрет.
 */

export const runtime = "nodejs";
/**
 * Лимит времени на serverless-функцию. Telegram ждёт ответ несколько секунд и
 * при отсутствии ответа шлёт update заново, поэтому вся обработка должна
 * укладываться в окно. На тарифе Hobby у Vercel потолок 10 с — держимся ниже.
 */
export const maxDuration = 10;

const Update = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      chat: z.object({ id: z.union([z.number(), z.string()]) }),
      from: z.object({ first_name: z.string().optional(), last_name: z.string().optional() }).optional(),
      text: z.string().optional(),
      contact: z.object({ phone_number: z.string() }).optional(),
      /**
       * Вложения. Без них zod молча отбрасывал голосовые, фото и видео:
       * сообщение приходило без текста, агент выходил на первой проверке, и
       * обращение пропадало целиком — ни в переписке, ни в уведомлениях.
       */
      ...TelegramAttachmentFields,
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().optional(),
      message: z.object({ chat: z.object({ id: z.union([z.number(), z.string()]) }) }).optional(),
      from: z.object({ first_name: z.string().optional(), last_name: z.string().optional() }).optional(),
    })
    .optional(),
});

const ok = () => NextResponse.json({ ok: true });

function msgType(u: z.infer<typeof Update>): string {
  if (u.callback_query) return "callback_query";
  if (u.message?.contact) return "contact";
  if (u.message?.voice) return "voice";
  if (u.message?.photo?.length) return "photo";
  if (u.message?.video || u.message?.video_note) return "video";
  if (u.message?.document) return "document";
  return "message";
}

export async function POST(req: Request) {
  if (!isTelegramConfigured()) return ok();

  // Секрет обязателен: без него адрес вебхука — единственная защита, а он
  // легко утекает в логах и настройках. Пустой секрет = открытый эндпоинт.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    console.error("TELEGRAM_WEBHOOK_SECRET не задан — вебхук отключён");
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: z.infer<typeof Update>;
  try {
    update = Update.parse(await req.json());
  } catch {
    return ok();
  }

  try {
    const company = await prisma.company.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
    if (!company) return ok();

    const msg = update.message;
    const cb = update.callback_query;

    // Идемпотентность: Telegram повторяет доставку при любой заминке.
    const dedupeKey = `tg:${update.update_id}`;
    try {
      await prisma.webhookEvent.create({
        data: {
          companyId: company.id,
          provider: "TELEGRAM",
          externalEventId: dedupeKey,
          eventType: msgType(update),
          payload: {},
          status: "PROCESSED",
          processedAt: new Date(),
        },
      });
    } catch {
      return ok(); // такой update уже обработан
    }

    const chatId = msg?.chat.id ?? cb?.message?.chat.id;
    if (!chatId) return ok();

    const from = msg?.from ?? cb?.from;
    const displayName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || null;

    if (cb?.id) await answerCallback(cb.id);

    /**
     * Ответ Telegram отдаём сразу, разговор ведём после.
     *
     * Разговор с моделью занимает секунды, а Telegram ждёт считанные: не
     * дождавшись, он присылает update заново. Он у нас уже помечен
     * обработанным, повтор отбрасывается — и сообщение остаётся без ответа. То
     * же самое, что случалось в WhatsApp, где пациенту приходилось писать
     * второй и третий раз.
     */
    runSerial(`telegram:${chatId}`, async () => {
      const reply = await handlePatientMessage(
        { companyId: company.id, channel: "TELEGRAM", externalUserId: String(chatId), displayName },
        {
          // Подпись к фото или видео — тоже текст пациента, и терять её нельзя.
          text: msg?.text ?? msg?.caption,
          phone: msg?.contact?.phone_number,
          callbackData: cb?.data,
          attachments: attachmentsFrom(msg),
          externalId: msg ? `tg:${chatId}:${msg.message_id}` : undefined,
        },
      );
      if (!reply) return;

      /**
       * Отмечаем исход отправки.
       *
       * Раньше результат выбрасывался, и все ответы в Telegram навсегда
       * оставались «в очереди» — даже те, что пациент получил и на которые
       * ответил. Из-за этого добор недоставленных не работал для канала вовсе:
       * он ищет пометку «не доставлено», а её никто не ставил. Ответ, который
       * не ушёл, не повторялся никогда, и пациент ждал в тишине.
       */
      const sent = reply.askPhone
        ? await requestPhone(chatId, reply.text)
        : msg?.contact
          ? await removeKeyboard(chatId, reply.text)
          : await sendText(chatId, reply.text, reply.buttons);

      if (reply.conversationId) {
        /**
         * Причину отказа берём у клиента и кладём рядом со статусом. Без неё
         * «FAILED» в базе не отличить от «FAILED»: заблокировал бот, кончился
         * лимит, оборвалась связь — это три разные проблемы и три разных
         * действия.
         */
        const reason = sent.ok ? null : (sent.error ?? null);
        if (!sent.ok) console.error(`[telegram] ответ не ушёл в чат ${chatId}: ${reason}`);
        await markDelivery(company.id, reply.conversationId, reply.text, sent.ok, reason).catch(
          () => {},
        );
      }
    });
  } catch (e) {
    // Telegram отвечаем 200, иначе он шлёт update по кругу. Но в лог пишем:
    // молчаливый catch однажды спрятал причину, по которой бот переставал
    // отвечать, и её пришлось искать вслепую.
    console.error("[telegram] обработка update упала:", e);
  }
  return ok();
}

/** Проверка живости вебхука. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    configured: isTelegramConfigured(),
    secretSet: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
  });
}
