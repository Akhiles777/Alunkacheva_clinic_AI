import { prisma } from "@/lib/db";
import { handlePatientMessage, type AgentChannel } from "./clinic-agent";
import { sendText as sendWhatsapp } from "@/lib/integrations/whatsapp/green-api";
import { lastSendError, sendText as sendTelegram } from "@/lib/integrations/telegram/client";
import { needsAnswer, QUIET_MINUTES, MAX_AGE_HOURS } from "./unanswered-rule";

/**
 * Добор неотвеченных сообщений.
 *
 * Пациенты жалуются, что сообщение приходится писать дважды: первое остаётся
 * без ответа, второе получает. Причин у этого несколько, и все они разные —
 * провайдер не принял отправку, модель ответила ошибкой, обработка упала на
 * середине. Ловить каждую по отдельности бесполезно: завтра появится
 * четвёртая, и человек снова будет писать дважды.
 *
 * Поэтому проверяем результат, а не причины: раз в круг ищем сообщения
 * пациентов, на которые агент должен был ответить и не ответил, и отвечаем.
 * Это тот же приём, что и с выгрузкой YCLIENTS — не надеяться, что дошло, а
 * посмотреть и добрать.
 *
 * Осторожность здесь важнее полноты. Берём только диалоги, где агент ведёт
 * разговор сам: если человек уже подключился или ждёт эскалация, второй ответ
 * поверх него хуже молчания.
 */

/** Сколько диалогов разбираем за круг: добор — подстраховка, а не нагрузка. */
const BATCH = 20;

export interface SweepResult {
  проверено: number;
  отвечено: number;
  /** Ответы, которые агент дал раньше, но канал не принял с первого раза. */
  доставлено: number;
  ошибок: number;
}

/**
 * Ответить на то, что осталось без ответа.
 *
 * Возвращает счётчики для экрана состояния: если добор срабатывает часто,
 * значит основная дорога ломается регулярно, и это надо чинить, а не
 * подпирать.
 */
/**
 * Отметить исход отправки на самом сообщении.
 *
 * Пока ответ агента сохранялся сразу как «отправлено», неудачная отправка
 * выглядела успешной: в инбоксе ответ есть, у пациента его нет. Теперь видно
 * оба состояния, и следующий круг может добрать именно доставку.
 */
export async function markDelivery(
  companyId: string,
  conversationId: string,
  body: string,
  ok: boolean,
  /**
   * Почему не ушло. Раньше не записывалось вовсе: в базе оставалось «FAILED»
   * без объяснения, и со стороны это выглядело как «бот молчит без причины».
   * А он отвечал — просто сообщения не доходили, и разбираться было не с чем.
   */
  reason?: string | null,
): Promise<void> {
  const row = await prisma.message.findFirst({
    where: { companyId, conversationId, direction: "OUT", body, status: "QUEUED" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!row) return;
  await prisma.message
    .update({
      where: { id: row.id },
      data: ok
        ? { status: "SENT", sentAt: new Date(), failureReason: null }
        : { status: "FAILED", failureReason: reason?.slice(0, 300) ?? null },
    })
    .catch(() => {});
}

/** Отправка в канал: у Telegram и WhatsApp разные ответы, сводим к одному. */
async function deliver(
  companyId: string,
  channel: string,
  externalUserId: string,
  reply: { text: string; buttons?: { text: string; data: string }[] },
): Promise<{ ok: boolean; error?: string }> {
  if (channel === "WHATSAPP") {
    const res = await sendWhatsapp(companyId, externalUserId, reply.text);
    return { ok: res.ok, error: res.error };
  }
  if (channel === "TELEGRAM") {
    const res = await sendTelegram(Number(externalUserId), reply.text, reply.buttons);
    // Причину берём у клиента: «не принял сообщение» не отличает блокировку
    // бота от оборванной связи, а действия по ним разные.
    return res ? { ok: true } : { ok: false, error: lastSendError() ?? "Telegram не принял сообщение" };
  }
  // Instagram отвечает только внутри суточного окна — добором не пользуемся.
  return { ok: false, error: `канал ${channel} добор не поддерживает` };
}

export async function answerUnanswered(companyId: string): Promise<SweepResult> {
  const now = Date.now();
  const quietBefore = new Date(now - QUIET_MINUTES * 60_000);
  const notOlderThan = new Date(now - MAX_AGE_HOURS * 3600_000);

  const conversations = await prisma.conversation.findMany({
    where: {
      companyId,
      // Только там, где разговор ведёт агент: перебивать человека нельзя.
      status: "BOT_ACTIVE",
      lastMessageAt: { gte: notOlderThan, lte: quietBefore },
      escalations: { none: { status: { not: "RESOLVED" } } },
    },
    orderBy: { lastMessageAt: "desc" },
    take: BATCH,
    select: {
      id: true,
      channel: true,
      externalUserId: true,
      contactName: true,
      botPausedUntil: true,
      messages: {
        where: { deletedAt: null, isDraft: false },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { direction: true, body: true, externalId: true, createdAt: true },
      },
    },
  });

  const result: SweepResult = { проверено: conversations.length, отвечено: 0, ошибок: 0, доставлено: 0 };

  /**
   * Ответы, которые агент дал, но канал не принял.
   *
   * Такой диалог заканчивается нашим сообщением, поэтому в разбор выше он не
   * попадает: там мы ищем последнее слово за пациентом. Отправляем заново —
   * это именно повтор доставки, второго ответа не сочиняем.
   */
  const undelivered = await prisma.message.findMany({
    where: {
      companyId,
      direction: "OUT",
      status: "FAILED",
      createdAt: { gte: notOlderThan },
      conversation: { status: "BOT_ACTIVE" },
    },
    orderBy: { createdAt: "asc" },
    take: BATCH,
    select: { id: true, body: true, conversation: { select: { channel: true, externalUserId: true } } },
  });

  for (const msg of undelivered) {
    const sent = await deliver(companyId, msg.conversation.channel, msg.conversation.externalUserId, {
      text: msg.body,
    });
    if (!sent.ok) continue;
    await prisma.message
      .update({ where: { id: msg.id }, data: { status: "SENT", sentAt: new Date() } })
      .catch(() => {});
    result.доставлено += 1;
  }

  for (const conv of conversations) {
    const last = conv.messages[0];
    // Кого добираем — решает одно правило, проверенное тестами.
    if (!last || !needsAnswer({ last, botPausedUntil: conv.botPausedUntil }, new Date())) continue;

    try {
      const reply = await handlePatientMessage(
        {
          companyId,
          channel: conv.channel as AgentChannel,
          externalUserId: conv.externalUserId,
          displayName: conv.contactName,
        },
        {
          text: last.body,
          externalId: last.externalId ?? undefined,
          // Сообщение уже в переписке: сохранять второй раз нельзя.
          alreadySaved: true,
        },
      );
      if (!reply?.text) continue;

      // У каналов разные ответы на отправку: приводим к одному виду.
      const sent = await deliver(companyId, conv.channel, conv.externalUserId, reply);
      await markDelivery(companyId, conv.id, reply.text, sent.ok, sent.error);

      if (sent.ok) result.отвечено += 1;
      else {
        result.ошибок += 1;
        console.error(`[добор] ответ не доставлен (${conv.channel}):`, sent.error);
      }
    } catch (e) {
      result.ошибок += 1;
      // Тело сообщения в журнал не пишем (§7): только то, что сорвалось.
      console.error("[добор] обработка не удалась:", (e as Error)?.message ?? e);
    }
  }

  return result;
}
