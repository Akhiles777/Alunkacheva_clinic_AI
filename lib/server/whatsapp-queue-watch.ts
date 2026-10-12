import { prisma } from "@/lib/db";
import { WHATSAPP_PROVIDER, isWhatsappEnabled } from "@/lib/integrations/whatsapp/config";
import { clearMessagesQueue, messagesQueue } from "@/lib/integrations/whatsapp/green-api";
import {
  EMPTY_WATCH,
  STALE_REASON,
  queueVerdict,
  type QueueWatch,
  type QueuedFact,
} from "@/lib/integrations/whatsapp/queue-rule";

/**
 * Очередь исходящих Green API — раз в минуту.
 *
 * Провайдер, у которого сломалась отправка, не отказывает, а принимает
 * сообщения и копит их до суток. Когда отправку починят, очередь уйдёт разом:
 * пациент получит ответ агента на вопрос, который ему давно закрыл
 * администратор, или три ответа подряд на одно сообщение. Решение заказчика
 * (12 октября): не ушло за пять минут или человек уже ответил — не отправлять.
 * Когда очищать, решает `queueVerdict`; здесь только факты и действие.
 *
 * Состояние в globalThis по той же причине, что у планировщика: модуль Next
 * загружает дважды. После перезапуска наблюдение начинается заново — вставшую
 * очередь заметим на пять минут позже, но не тронем движущуюся.
 */
const shared = ((globalThis as Record<string, unknown>).__clinicWaQueueWatch ??= {
  watch: {} as Record<string, QueueWatch>,
  running: false,
}) as { watch: Record<string, QueueWatch>; running: boolean };

export const QUEUE_CHECK_INTERVAL_MIN = 1;

export async function runWhatsappQueueWatch(): Promise<void> {
  if (!isWhatsappEnabled() || shared.running) return;
  shared.running = true;
  try {
    const companies = await prisma.credential.findMany({
      where: { provider: WHATSAPP_PROVIDER },
      distinct: ["companyId"],
      select: { companyId: true },
    });
    for (const { companyId } of companies) {
      await watchCompany(companyId).catch((e) =>
        console.error("[wa-queue] проверка очереди:", (e as Error)?.message ?? e),
      );
    }
  } finally {
    shared.running = false;
  }
}

async function watchCompany(companyId: string): Promise<void> {
  const queue = await messagesQueue(companyId);
  // Провайдер не ответил — об очереди ничего не знаем, и прошлое не забываем.
  if (!queue) return;
  const prev = shared.watch[companyId] ?? EMPTY_WATCH;
  if (queue.length === 0) {
    shared.watch[companyId] = EMPTY_WATCH;
    return;
  }

  const ours = await prisma.message.findMany({
    where: { companyId, channel: "WHATSAPP", externalId: { in: queue.map((q) => q.id) } },
    select: {
      id: true,
      externalId: true,
      createdAt: true,
      conversation: {
        select: {
          messages: {
            where: { deletedAt: null, isDraft: false },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { createdAt: true },
          },
        },
      },
    },
  });
  const byExternal = new Map(ours.map((m) => [m.externalId, m]));
  const facts: QueuedFact[] = queue.map((q) => {
    const m = byExternal.get(q.id);
    if (!m) return { id: q.id };
    const latest = m.conversation.messages[0]?.createdAt;
    return { id: q.id, ourCreatedAt: m.createdAt, repliedAfter: Boolean(latest && latest > m.createdAt) };
  });

  const verdict = queueVerdict(prev, facts, Date.now());
  shared.watch[companyId] = verdict.next;
  if (!verdict.clear) return;

  const cleared = await clearMessagesQueue(companyId);
  if (!cleared) {
    console.error(`[wa-queue] очистить очередь не удалось (${queue.length} в очереди, ${verdict.reason})`);
    return;
  }
  /**
   * Наши сообщения из очереди — «не ушло» с причиной словами: в переписке
   * администратор видит, что сообщение снято, а не висит неизвестно где.
   * Если провайдер всё же успел отправить какое-то из них, его статус «sent»
   * придёт вебхуком, и опоздавшее сообщение будет удалено у пациента
   * (`late-delivery.ts`).
   */
  if (ours.length > 0) {
    await prisma.message.updateMany({
      where: { id: { in: ours.map((m) => m.id) } },
      data: { status: "FAILED", failureReason: STALE_REASON },
    });
  }
  console.warn(
    `[wa-queue] очередь Green API очищена: ${queue.length} сообщ. (наших ${ours.length}) — ${verdict.reason}`,
  );
}
