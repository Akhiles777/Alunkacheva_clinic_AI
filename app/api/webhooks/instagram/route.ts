import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePatientMessage } from "@/lib/agent/clinic-agent";
import { markDelivery } from "@/lib/agent/unanswered";
import { isInstagramEnabled, INSTAGRAM_PROVIDER } from "@/lib/integrations/instagram/config";
import { parseWebhook, verifyChallenge, verifySignature } from "@/lib/integrations/instagram/webhook";
import { sendInstagram } from "@/lib/integrations/instagram/client";

/**
 * Вебхук Instagram Direct.
 *
 * Отвечаем 200 почти всегда и быстро: на другой код Meta повторяет доставку, и
 * пациент получает дубли ответов. Отказ отдаём только там, где повтор
 * бессмысленен — выключенная интеграция и неверная подпись.
 *
 * Идемпотентность: сообщение сохраняется с mid от Meta, а на паре
 * (channel, externalId) стоит уникальный индекс. Повторная доставка того же
 * сообщения не создаёт второй записи и не запускает второй ответ.
 */
export const runtime = "nodejs";
export const maxDuration = 20;

/** Подключение вебхука: Meta присылает GET и ждёт обратно challenge. */
export async function GET(req: Request) {
  const challenge = verifyChallenge(new URL(req.url).searchParams);
  if (!challenge) return NextResponse.json({ error: "verification failed" }, { status: 403 });
  return new NextResponse(challenge, { headers: { "Content-Type": "text/plain" } });
}

export async function POST(req: Request) {
  if (!isInstagramEnabled()) {
    return NextResponse.json({ error: "instagram disabled" }, { status: 503 });
  }

  /**
   * Тело читаем строкой: подпись считается по исходным байтам. Пересобранный
   * JSON отличается пробелами и порядком ключей, и подпись бы не сошлась.
   */
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true, ignored: "invalid json" });
  }

  /**
   * Клиника-адресат: та, у которой заведён токен страницы. При
   * неоднозначности берём самую раннюю — как и во всём остальном интерфейсе.
   * Требовать «ровно одну клинику» нельзя: лишняя строка в таблице однажды
   * уже стоила потерянных сообщений в WhatsApp.
   */
  const companyId = await resolveCompany();
  if (!companyId) return NextResponse.json({ ok: true, ignored: "в базе нет ни одной клиники" });

  const events = parseWebhook(body);
  const outcome: Record<string, number> = { принято: 0, повтор: 0, пропущено: 0 };

  for (const event of events) {
    if (event.kind !== "message") {
      outcome.пропущено += 1;
      continue;
    }

    const seen = await prisma.message.findFirst({
      where: { channel: "INSTAGRAM", externalId: event.externalId },
      select: { id: true },
    });
    if (seen) {
      outcome.повтор += 1;
      continue;
    }

    try {
      const reply = await handlePatientMessage(
        {
          companyId,
          channel: "INSTAGRAM",
          externalUserId: event.senderId,
          // Имени Meta в сообщении не присылает: оно доступно отдельным
          // запросом профиля, и без права на него мы его не увидим.
          displayName: null,
        },
        { text: event.text, externalId: event.externalId, attachments: event.attachments },
      );

      if (reply?.text) {
        /**
         * Окно ответа считается от последнего сообщения пациента — берём его
         * из диалога, который только что обновил агент.
         */
        const conv = await prisma.conversation.findFirst({
          where: { companyId, channel: "INSTAGRAM", externalUserId: event.senderId },
          select: { lastPatientMessageAt: true },
        });
        const sent = await sendInstagram(
          companyId,
          event.senderId,
          reply.text,
          conv?.lastPatientMessageAt ?? new Date(),
        );
        if (!sent.ok) {
          // Ответ не ушёл. Сообщение пациента уже сохранено и видно
          // администратору — это лучше, чем потерять обращение целиком.
          console.error("[instagram] ответ не доставлен:", sent.error);
        }
        /**
         * Отмечаем исход отправки на самом сообщении.
         *
         * Без отметки ответ навсегда оставался «в очереди», и добор
         * недоставленных проходил мимо: он ищет пометку «не доставлено», а
         * ставить её было некому. Тот же пробел был в Telegram — там ответы
         * пациенту терялись молча и не повторялись никогда.
         */
        if (reply.conversationId) {
          await markDelivery(companyId, reply.conversationId, reply.text, sent.ok).catch(() => {});
        }
      }
      outcome.принято += 1;
    } catch (e) {
      console.error("[instagram] сбой обработки:", e);
      outcome.пропущено += 1;
    }
  }

  return NextResponse.json({ ok: true, ...outcome });
}

async function resolveCompany(): Promise<string | null> {
  const configured = await prisma.credential.findMany({
    where: { provider: INSTAGRAM_PROVIDER, keyName: "page_token" },
    select: { companyId: true },
    take: 2,
  });
  if (configured.length === 1) return configured[0].companyId;

  const oldest = await prisma.company.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  return oldest?.id ?? null;
}
