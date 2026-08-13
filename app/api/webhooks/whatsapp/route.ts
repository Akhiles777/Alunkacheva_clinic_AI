import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePatientMessage } from "@/lib/agent/clinic-agent";
import { isWhatsappEnabled } from "@/lib/integrations/whatsapp/config";
import { parseWebhook, verifyWebhookSecret } from "@/lib/integrations/whatsapp/webhook";
import { sendText } from "@/lib/integrations/whatsapp/green-api";

/**
 * Вебхук WhatsApp (Green API).
 *
 * Отвечаем 200 почти всегда и быстро: на другой код провайдер повторяет
 * доставку, и пациент получает дубли ответов. Отказ отдаём только там, где
 * повтор бессмысленен — выключенная интеграция и неверный секрет.
 *
 * Идемпотентность: сообщение сохраняется с externalId провайдера, а на паре
 * (channel, externalId) стоит уникальный индекс. Повторная доставка того же
 * сообщения не создаёт второй записи и не запускает второй ответ.
 */

export const runtime = "nodejs";
/**
 * Провайдер ждёт ответ считанные секунды. Не уложились — пришлёт заново,
 * поэтому обработка должна быть короткой.
 */
export const maxDuration = 20;

export async function POST(req: Request) {
  if (!isWhatsappEnabled()) {
    return NextResponse.json({ error: "whatsapp disabled" }, { status: 503 });
  }
  if (!verifyWebhookSecret(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "invalid secret" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // Разобрать не смогли — повторять бессмысленно, но и ошибку провайдеру
    // отдавать незачем: он будет слать это же тело по кругу.
    return NextResponse.json({ ok: true, ignored: "invalid json" });
  }

  const event = parseWebhook(body);

  if (event.kind !== "message") {
    /**
     * Статусы доставки, эхо собственных сообщений, смена состояния инстанса и
     * звонки. Их достаточно подтвердить: заводить на них переписку нельзя.
     */
    return NextResponse.json({ ok: true, kind: event.kind });
  }

  /**
   * Филиал определяем по единственной компании: у платформы одна клиника, а
   * Green API не сообщает, к какому нашему филиалу относится инстанс. Если
   * когда-нибудь клиник станет несколько, различать их придётся по idInstance
   * из instanceData — поэтому здесь стоит явная проверка, а не «взять первую».
   */
  const companies = await prisma.company.findMany({ select: { id: true }, take: 2 });
  if (companies.length !== 1) {
    return NextResponse.json({ ok: true, ignored: "не удалось определить клинику" });
  }
  const companyId = companies[0].id;

  /**
   * Повторная доставка. Провайдер шлёт событие заново, если не получил ответ
   * вовремя, — а обработать одно сообщение дважды значит ответить пациенту
   * дважды.
   */
  const seen = await prisma.message.findFirst({
    where: { channel: "WHATSAPP", externalId: event.externalId },
    select: { id: true },
  });
  if (seen) return NextResponse.json({ ok: true, duplicate: true });

  try {
    const reply = await handlePatientMessage(
      {
        companyId,
        channel: "WHATSAPP",
        externalUserId: event.chatId,
        displayName: event.senderName,
      },
      { text: event.text, externalId: event.externalId },
    );

    if (reply?.text) {
      const sent = await sendText(companyId, event.chatId, withButtonsAsText(reply));
      if (!sent.ok) {
        // Ответ не ушёл. Сообщение пациента уже сохранено, диалог виден
        // администратору — это лучше, чем потерять обращение целиком.
        console.error("[whatsapp] ответ не доставлен:", sent.error);
      }
    }
  } catch (e) {
    // Сбой обработки не должен приводить к повторной доставке: сообщение
    // сохранено, ответ можно дать вручную.
    console.error("[whatsapp] сбой обработки:", e);
  }

  return NextResponse.json({ ok: true });
}

/**
 * Кнопки в текст.
 *
 * В Telegram агент предлагает варианты кнопками. В WhatsApp через Green API
 * их нет, и молча терять подсказки нельзя — пациент остался бы без понимания,
 * что можно спросить. Поэтому дописываем строкой.
 */
function withButtonsAsText(reply: { text: string; buttons?: { text: string }[] }): string {
  if (!reply.buttons?.length) return reply.text;
  const options = reply.buttons.map((b) => `• ${b.text}`).join("\n");
  return `${reply.text}\n\n${options}`;
}
