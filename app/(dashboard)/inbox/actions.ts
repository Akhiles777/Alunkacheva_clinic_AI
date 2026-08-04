"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { inboxRecipients, notifyStaff } from "@/lib/server/notify";
import { humanTakeoverUntil } from "@/lib/agent/clinic-agent";
import { sendText as sendTelegram } from "@/lib/integrations/telegram/client";
import { settingsStore, type TemplateItem } from "@/app/_data/settings";
import type { ConversationStatus } from "@/generated/prisma/enums";

/**
 * Утверждённые WhatsApp-шаблоны для инбокса — из сохранённых настроек (раздел
 * «Шаблоны»), а не из мок-стора. Вне 24-часового окна писать можно только ими.
 */
export interface ApprovedTemplate {
  id: string;
  title: string;
  body: string;
}

export async function getApprovedTemplates(): Promise<ApprovedTemplate[]> {
  const session = await getSession();
  const row = await prisma.setting.findUnique({
    where: { companyId_key: { companyId: session.companyId, key: "templates" } },
  });
  const stored = row?.value as { templates?: TemplateItem[] } | null;
  const templates = stored?.templates ?? settingsStore.templates;
  return templates
    .filter((t) => t.status === "approved")
    .map((t) => ({ id: t.id, title: t.title, body: t.body }));
}

/**
 * Диалоги инбокса — из доменных таблиц Conversation + Message.
 *
 * Состояние считается на сервере, а не в клиентском сторе: «непрочитано»,
 * причина эскалации и окно ответа раньше брались из мока и для диалогов из
 * базы всегда были пустыми — поэтому фильтр «Нужен ответ» показывал пусто,
 * даже когда пациент ждал ответа.
 */
export type DialogChannel = "instagram" | "whatsapp" | "telegram";
export type DialogStatus = "bot" | "escalated" | "human" | "closed";

export interface DialogMessageRecord {
  id: string;
  from: "patient" | "bot" | "staff";
  text: string;
  at: string;
}
export interface DialogRecord {
  id: string;
  name: string | null;
  patientId: string | null;
  channel: DialogChannel;
  /** Последнее слово за пациентом — диалог ждёт ответа. */
  unread: boolean;
  /** Почему диалог передан человеку. */
  escalationReason: string | null;
  /** Можно ли писать свободным текстом (24-часовое окно Instagram). */
  windowOpen: boolean;
  /** Сколько минут осталось до закрытия окна; null — окно без таймера. */
  windowMinutesLeft: number | null;
  status: DialogStatus;
  preview: string;
  at: string;
  messages: DialogMessageRecord[];
}

const STATUS_MAP: Record<ConversationStatus, DialogStatus> = {
  BOT_ACTIVE: "bot",
  ESCALATED: "escalated",
  HUMAN_TAKEOVER: "human",
  CLOSED: "closed",
};

const timeFmt = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});
const dateFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  timeZone: "Europe/Moscow",
});

function atLabel(d: Date): string {
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  if (d >= startToday) return timeFmt.format(d);
  if (d >= new Date(startToday.getTime() - day)) return "вчера";
  return dateFmt.format(d);
}

const CHANNEL_MAP: Record<string, DialogChannel> = {
  INSTAGRAM: "instagram",
  WHATSAPP: "whatsapp",
  TELEGRAM: "telegram",
};

const ESCALATION_LABEL: Record<string, string> = {
  AGENT_REQUEST: "агент позвал человека",
  PATIENT_REQUEST: "пациент просит человека",
  KEYWORD: "стоп-слово",
  MEDICAL_QUESTION: "медицинский вопрос",
  MISUNDERSTOOD: "агент не понял запрос",
  TIMEOUT: "агент долго молчал",
  OTHER: "другое",
};

export async function getConversations(): Promise<DialogRecord[]> {
  const session = await getSession();
  const convs = await prisma.conversation.findMany({
    where: { companyId: session.companyId },
    orderBy: { lastMessageAt: "desc" },
    include: {
      patient: { select: { name: true } },
      messages: { where: { deletedAt: null, isDraft: false }, orderBy: { createdAt: "asc" } },
      escalations: {
        where: { status: { not: "RESOLVED" } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { reason: true },
      },
    },
  });
  return convs.map((c) => {
    const messages: DialogMessageRecord[] = c.messages.map((m) => ({
      id: m.id,
      from: m.authorType === "PATIENT" ? "patient" : m.authorType === "BOT" ? "bot" : "staff",
      text: m.body,
      at: atLabel(m.createdAt),
    }));
    const last = c.messages[c.messages.length - 1];
    // Ждёт ответа, если последним написал пациент и диалог не закрыт.
    const unread = last?.direction === "IN" && c.status !== "CLOSED";
    // Окно 24 часов — ограничение Instagram. В Telegram и WhatsApp его нет.
    const windowLeftMs = c.replyWindowExpiresAt ? c.replyWindowExpiresAt.getTime() - Date.now() : null;
    return {
      id: c.id,
      name: c.patient?.name ?? null,
      patientId: c.patientId,
      channel: CHANNEL_MAP[c.channel] ?? "whatsapp",
      status: STATUS_MAP[c.status],
      unread,
      escalationReason: c.escalations[0] ? ESCALATION_LABEL[c.escalations[0].reason] ?? null : null,
      windowOpen: c.channel !== "INSTAGRAM" || windowLeftMs === null || windowLeftMs > 0,
      windowMinutesLeft:
        c.channel === "INSTAGRAM" && windowLeftMs !== null && windowLeftMs > 0
          ? Math.round(windowLeftMs / 60000)
          : null,
      preview: last?.body ?? "",
      at: atLabel(c.lastMessageAt),
      messages,
    };
  });
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/**
 * Ответ администратора пациенту.
 *
 * Сообщение не только сохраняется, но и уходит в канал. Раньше оно просто
 * ложилось в базу: администратор писал, видел свой текст в переписке и был
 * уверен, что ответил, — а пациент не получал ничего.
 *
 * Instagram и WhatsApp пока не подключены (этап 2), поэтому там сообщение
 * помечается как неотправленное с честной причиной, а не тихо «отправляется».
 */
export async function sendMessageDb(
  conversationId: string,
  messageId: string,
  text: string,
): Promise<SendResult> {
  const session = await getSession();
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId: session.companyId },
    select: { channel: true, externalUserId: true },
  });
  if (!conv) return { ok: false, error: "Диалог не найден" };

  const body = text.trim();
  let delivered = false;
  let failure: string | null = null;
  let externalId: string | null = null;

  if (conv.channel === "TELEGRAM") {
    const res = await sendTelegram(conv.externalUserId, body);
    if (res) {
      delivered = true;
      externalId = res.externalId;
    } else {
      failure = "Telegram не принял сообщение. Проверьте настройки бота.";
    }
  } else {
    failure = "Канал ещё не подключён — сообщение сохранено, но пациенту не ушло.";
  }

  await prisma.$transaction([
    prisma.message.create({
      data: {
        id: messageId,
        companyId: session.companyId,
        conversationId,
        channel: conv.channel,
        direction: "OUT",
        authorType: "STAFF",
        authorId: session.userId,
        body,
        externalId,
        status: delivered ? "SENT" : "FAILED",
        failureReason: failure,
        sentAt: delivered ? new Date() : null,
      },
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      // Сотрудник ответил вручную — агент замолкает на 12 часов (§6.4).
      // Бот, перебивающий администратора, — худший баг в этой системе.
      data: { status: "HUMAN_TAKEOVER", lastMessageAt: new Date(), botPausedUntil: humanTakeoverUntil() },
    }),
  ]);

  // Диалог перешёл к человеку — остальным администраторам это важно знать,
  // чтобы двое не отвечали одному пациенту одновременно.
  await notifyStaff({
    companyId: session.companyId,
    recipientIds: await inboxRecipients(session.companyId, session.userId),
    kind: "PATIENT_MESSAGE",
    title: "Диалог взят в работу",
    body: "Коллега ответил пациенту вручную",
    url: "/inbox",
    entityId: conversationId,
  });

  return failure ? { ok: false, error: failure } : { ok: true };
}

export async function startDialogDb(input: {
  id: string;
  messageId: string;
  channel: DialogChannel;
  patientId: string | null;
  message: string;
}): Promise<void> {
  const session = await getSession();
  const channel = input.channel === "instagram" ? "INSTAGRAM" : "WHATSAPP";
  const now = new Date();
  await prisma.conversation.create({
    data: {
      id: input.id,
      companyId: session.companyId,
      patientId: input.patientId,
      channel,
      externalUserId: `local-${input.id}`,
      status: "HUMAN_TAKEOVER",
      startedAt: now,
      lastMessageAt: now,
      messages: {
        create: {
          id: input.messageId,
          companyId: session.companyId,
          channel,
          direction: "OUT",
          authorType: "STAFF",
          authorId: session.userId,
          body: input.message.trim(),
        },
      },
    },
  });
}

