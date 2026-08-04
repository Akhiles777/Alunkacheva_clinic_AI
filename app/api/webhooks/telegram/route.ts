import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { handlePatientMessage } from "@/lib/agent/clinic-agent";
import { answerCallback, isTelegramConfigured, removeKeyboard, requestPhone, sendText } from "@/lib/integrations/telegram/client";

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

const Update = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      chat: z.object({ id: z.union([z.number(), z.string()]) }),
      from: z.object({ first_name: z.string().optional(), last_name: z.string().optional() }).optional(),
      text: z.string().optional(),
      contact: z.object({ phone_number: z.string() }).optional(),
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
  return "message";
}

export async function POST(req: Request) {
  if (!isTelegramConfigured()) return ok();

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
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

    const reply = await handlePatientMessage(
      { companyId: company.id, channel: "TELEGRAM", externalUserId: String(chatId), displayName },
      {
        text: msg?.text,
        phone: msg?.contact?.phone_number,
        callbackData: cb?.data,
        externalId: msg ? `tg:${chatId}:${msg.message_id}` : undefined,
      },
    );

    if (reply) {
      if (reply.askPhone) await requestPhone(chatId, reply.text);
      else if (msg?.contact) await removeKeyboard(chatId, reply.text);
      else await sendText(chatId, reply.text, reply.buttons);
    }
  } catch {
    // Ошибку не показываем Telegram: иначе он будет слать этот update по кругу.
  }
  return ok();
}

/** Проверка живости вебхука. */
export async function GET() {
  return NextResponse.json({ ok: true, configured: isTelegramConfigured() });
}
