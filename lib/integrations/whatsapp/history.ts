import { prisma } from "@/lib/db";
import { fetchChatHistory } from "./green-api";
import { humanTakeoverUntil } from "@/lib/agent/clinic-agent";

/**
 * Перенос переписки из WhatsApp в диалог платформы.
 *
 * До подключения платформы клиника переписывалась с пациентом прямо на
 * телефоне, иногда годами. Для нас этих сообщений не существовало: первое же
 * обращение выглядело как разговор с незнакомым человеком — ассистент
 * здоровался, заново просил согласие на обработку данных и переспрашивал то,
 * что человек уже рассказывал. Именно так вышло с пациенткой, которая
 * обращалась в клинику не первый раз.
 *
 * Поэтому при первом сообщении в новом диалоге забираем историю чата у
 * провайдера и складываем её в переписку. Дальше она работает как обычная
 * история: её видит администратор в инбоксе и её читает агент, когда собирает
 * контекст разговора.
 *
 * Делается ровно один раз — при первом сообщении. Дальше переписка приходит
 * вебхуками, и перезабирать её незачем.
 */

/** Сколько сообщений тянем. Хватает, чтобы понять, о чём был разговор. */
const HISTORY_COUNT = 50;

/**
 * Насколько старую переписку считаем «той же»: год.
 *
 * Разговор трёхлетней давности контекстом для сегодняшнего обращения не
 * является, а место в переписке занимает.
 */
const MAX_AGE_DAYS = 365;

export interface ImportResult {
  imported: number;
  /** Последнее слово в старой переписке осталось за сотрудником клиники. */
  staffWasLast: boolean;
}

export async function importWhatsappHistory(input: {
  companyId: string;
  chatId: string;
  contactName?: string | null;
  /**
   * Сообщение, ради которого сработал вебхук. В историю оно уже попало, но
   * сохранит его обычный путь обработки — здесь его пропускаем, иначе в
   * переписке будет две копии.
   */
  skipExternalId?: string | null;
}): Promise<ImportResult> {
  const none: ImportResult = { imported: 0, staffWasLast: false };

  const existing = await prisma.conversation.findFirst({
    where: { companyId: input.companyId, channel: "WHATSAPP", externalUserId: input.chatId },
    select: { id: true, _count: { select: { messages: true } } },
  });
  // В диалоге уже есть переписка — контекст на месте, тянуть нечего.
  if (existing && existing._count.messages > 0) return none;

  const history = await fetchChatHistory(input.companyId, input.chatId, HISTORY_COUNT);
  if (history.length === 0) return none;

  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000);
  const fresh = history.filter((m) => m.at >= cutoff && m.externalId !== input.skipExternalId);
  if (fresh.length === 0) return none;

  const conversationId = existing?.id ?? (await createConversation(input.companyId, input.chatId, input.contactName));

  const created = await prisma.message.createMany({
    data: fresh.map((m) => ({
      companyId: input.companyId,
      conversationId,
      channel: "WHATSAPP" as const,
      direction: m.direction,
      // Кто именно из клиники писал с телефона — провайдер не сообщает, да и
      // отвечал живой человек, а не бот.
      authorType: m.direction === "IN" ? ("PATIENT" as const) : ("STAFF" as const),
      body: m.text,
      externalId: m.externalId,
      status: m.direction === "OUT" ? ("SENT" as const) : undefined,
      sentAt: m.direction === "OUT" ? m.at : undefined,
      createdAt: m.at,
    })),
    // Часть сообщений могла прийти вебхуком раньше: уникальный индекс по
    // externalId их отсеет, а вся пачка из-за этого падать не должна.
    skipDuplicates: true,
  });

  const last = fresh[fresh.length - 1];
  const staffWasLast = last.direction === "OUT" && last.at >= new Date(Date.now() - 12 * 3600 * 1000);

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      startedAt: fresh[0].at,
      /**
       * Разговор вёл сотрудник — бот в него не вклинивается.
       *
       * То же правило, что и при ответе из инбокса (§6.4): пока человек
       * разговаривает с пациентом, агент молчит. Разница лишь в том, что
       * разговор шёл на телефоне, а не у нас на экране.
       */
      ...(staffWasLast ? { status: "HUMAN_TAKEOVER" as const, botPausedUntil: humanTakeoverUntil() } : {}),
    },
  });

  return { imported: created.count, staffWasLast };
}

/** Диалог для истории, если сообщений от пациента у нас ещё не было. */
async function createConversation(
  companyId: string,
  chatId: string,
  contactName?: string | null,
): Promise<string> {
  const source = await prisma.source.findFirst({
    where: { companyId, code: "whatsapp" },
    select: { id: true },
  });
  const conv = await prisma.conversation.create({
    data: {
      companyId,
      channel: "WHATSAPP",
      externalUserId: chatId,
      contactName: contactName ?? null,
      status: "BOT_ACTIVE",
      sourceId: source?.id ?? null,
      startedAt: new Date(),
      lastMessageAt: new Date(),
    },
    select: { id: true },
  });
  return conv.id;
}
