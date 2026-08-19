"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { titleFrom } from "@/lib/assistant/chat-title";

/**
 * Сохранённые разговоры владельца с ИИ-аналитиком.
 *
 * Разбор жил до перезагрузки страницы: владелец спрашивал «где мы теряем
 * деньги», получал анализ и терял его вместе со вкладкой. Каждый чат теперь
 * своя задача, к которой можно вернуться.
 *
 * Только владелец. Разбор выручки и эффективности сотрудников — не то, что
 * должно лежать в общем доступе, и разграничение здесь проще сделать сразу,
 * чем разбирать потом (§7).
 */
export interface AiChatSummary {
  id: string;
  title: string;
  /** Подпись времени последнего сообщения: «сегодня», «12 августа». */
  at: string;
  messages: number;
}

export interface AiChatTurn {
  role: "user" | "assistant";
  text: string;
}

const when = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "long",
});

/** Владелец — и никто больше. */
async function ownerSession() {
  const session = await getSession();
  if (session.role !== "OWNER") throw new Error("Раздел доступен только владельцу");
  if (!session.userId) throw new Error("Не удалось определить пользователя");
  return { companyId: session.companyId, userId: session.userId };
}

export async function listAiChats(): Promise<AiChatSummary[]> {
  const { companyId, userId } = await ownerSession();
  const rows = await prisma.aiChat.findMany({
    where: { companyId, userId, deletedAt: null },
    orderBy: { lastMessageAt: "desc" },
    take: 100,
    select: {
      id: true,
      title: true,
      lastMessageAt: true,
      _count: { select: { messages: true } },
    },
  });
  const today = when.format(new Date());
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    at: when.format(r.lastMessageAt) === today ? "сегодня" : when.format(r.lastMessageAt),
    messages: r._count.messages,
  }));
}

export async function getAiChat(chatId: string): Promise<AiChatTurn[]> {
  const { companyId, userId } = await ownerSession();
  const chat = await prisma.aiChat.findFirst({
    where: { id: chatId, companyId, userId, deletedAt: null },
    select: {
      messages: { orderBy: { createdAt: "asc" }, select: { role: true, text: true } },
    },
  });
  if (!chat) return [];
  return chat.messages.map((m) => ({
    role: m.role === "USER" ? ("user" as const) : ("assistant" as const),
    text: m.text,
  }));
}

/**
 * Записать пару «вопрос — ответ».
 *
 * Пишем оба сообщения разом и одной транзакцией: половина разговора в базе
 * хуже, чем ничего — по ней не понять, ответил аналитик или нет.
 *
 * Чат создаётся здесь же, если его ещё нет: заводить пустой при нажатии
 * «новый разбор» незачем, список наполнялся бы безымянными пустышками.
 */
export async function appendAiTurn(input: {
  chatId: string | null;
  question: string;
  answer: string;
}): Promise<{ chatId: string; title: string }> {
  const { companyId, userId } = await ownerSession();
  const now = new Date();

  const chatId =
    input.chatId ??
    (
      await prisma.aiChat.create({
        data: { companyId, userId, title: titleFrom(input.question), lastMessageAt: now },
        select: { id: true },
      })
    ).id;

  const chat = await prisma.aiChat.findFirst({
    where: { id: chatId, companyId, userId, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!chat) throw new Error("Разговор не найден");

  await prisma.$transaction([
    prisma.aiChatMessage.createMany({
      data: [
        { chatId: chat.id, role: "USER", text: input.question },
        { chatId: chat.id, role: "ASSISTANT", text: input.answer },
      ],
    }),
    prisma.aiChat.update({ where: { id: chat.id }, data: { lastMessageAt: now } }),
  ]);

  return { chatId: chat.id, title: chat.title };
}

export async function renameAiChat(chatId: string, title: string): Promise<void> {
  const { companyId, userId } = await ownerSession();
  const clean = title.trim().slice(0, 120);
  if (clean.length === 0) return;
  await prisma.aiChat.updateMany({
    where: { id: chatId, companyId, userId, deletedAt: null },
    data: { title: clean },
  });
}

/** Мягкое удаление: разбор мог понадобиться в разговоре с клиентом. */
export async function deleteAiChat(chatId: string): Promise<void> {
  const { companyId, userId } = await ownerSession();
  await prisma.aiChat.updateMany({
    where: { id: chatId, companyId, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
}
