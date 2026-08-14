import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { handlePatientMessage } from "@/lib/agent/clinic-agent";
import { isWhatsappEnabled, WHATSAPP_PROVIDER } from "@/lib/integrations/whatsapp/config";
import { parseWebhook, verifyWebhookSecret } from "@/lib/integrations/whatsapp/webhook";
import { sendText } from "@/lib/integrations/whatsapp/green-api";
import { humanTakeoverUntil } from "@/lib/agent/clinic-agent";
import { messageBody } from "@/lib/agent/attachments";

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

  if (event.kind !== "message" && event.kind !== "outgoing") {
    /**
     * Статусы доставки, эхо собственных сообщений, смена состояния инстанса и
     * звонки. Их достаточно подтвердить: заводить на них переписку нельзя.
     */
    return NextResponse.json({ ok: true, kind: event.kind });
  }

  /**
   * Чью клинику касается сообщение.
   *
   * Прежде требовалось, чтобы в базе была ровно одна клиника. На боевой базе
   * их оказалось две — настоящая и пустая запись, оставшаяся от ранней
   * настройки, — и каждое сообщение из WhatsApp молча выбрасывалось с
   * пометкой «не удалось определить клинику». Пациент писал, а в инбоксе не
   * появлялось ничего: лишняя строка в таблице стоила потерянных обращений.
   *
   * Теперь порядок такой: клиника, у которой заведены ключи Green API; если
   * такая одна — она и есть адресат. Иначе берём самую раннюю, как и весь
   * остальной интерфейс платформы.
   */
  const companyId = await resolveCompany();
  if (!companyId) {
    return NextResponse.json({ ok: true, ignored: "в базе нет ни одной клиники" });
  }

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

  /**
   * Администратор ответил пациенту прямо в WhatsApp на телефоне.
   *
   * Сохраняем его сообщение в переписку и переводим диалог под управление
   * человека: бот замолкает на те же 12 часов, что и после ответа из инбокса
   * (§6.4). Без этого получалось, что человек уже разговаривает с пациентом,
   * а бот отвечает поверх него — и оба выглядят несогласованно.
   */
  if (event.kind === "outgoing") {
    const conv = await prisma.conversation.findFirst({
      where: { companyId, channel: "WHATSAPP", externalUserId: event.chatId },
      select: { id: true },
    });
    // Нет диалога — значит переписку начал сам администратор, и первое
    // сообщение пациента ещё не приходило. Заводить диалог здесь не нужно:
    // он появится, когда пациент ответит.
    if (!conv) return NextResponse.json({ ok: true, ignored: "нет диалога" });

    await prisma.message.create({
      data: {
        companyId,
        conversationId: conv.id,
        channel: "WHATSAPP",
        direction: "OUT",
        authorType: "STAFF",
        body: messageBody(event.text, event.attachments).slice(0, 4000),
        externalId: event.externalId,
        status: "SENT",
        sentAt: new Date(),
      },
    });
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        status: "HUMAN_TAKEOVER",
        botPausedUntil: humanTakeoverUntil(),
        lastMessageAt: new Date(),
      },
    });
    return NextResponse.json({ ok: true, kind: "outgoing", takeover: true });
  }

  try {
    const reply = await handlePatientMessage(
      {
        companyId,
        channel: "WHATSAPP",
        externalUserId: event.chatId,
        displayName: event.senderName,
      },
      {
        text: event.text,
        externalId: event.externalId,
        attachments: event.attachments,
        // В WhatsApp адрес чата и есть телефон — карточка пациента
        // привязывается сразу, спрашивать номер незачем.
        knownPhone: event.phoneE164,
      },
    );

    if (reply?.text) {
      const sent = await sendText(companyId, event.chatId, reply.text);
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

/** Клиника, которой адресовано сообщение WhatsApp. */
async function resolveCompany(): Promise<string | null> {
  const configured = await prisma.credential.findMany({
    where: { provider: WHATSAPP_PROVIDER, keyName: "id_instance" },
    select: { companyId: true },
    take: 2,
  });
  if (configured.length === 1) return configured[0].companyId;

  const oldest = await prisma.company.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return oldest?.id ?? null;
}

/*
 * Подсказок под сообщениями в WhatsApp нет намеренно.
 *
 * В Telegram это кнопки: они не занимают место в переписке и нажимаются одним
 * касанием. В WhatsApp кнопок нет, и раньше их подписи дописывались строками
 * под каждый ответ — «Услуги и цены, Адрес, Часы работы, Позвать
 * администратора». В живой переписке это выглядит как навязчивое меню под
 * каждой репликой, а не как разговор.
 *
 * Понимать эти слова агент по-прежнему умеет: пациент может написать «адрес»
 * или «позвать администратора», и они сработают (см. lib/agent/text-actions).
 * Перечислять их в каждом сообщении для этого не нужно.
 */
