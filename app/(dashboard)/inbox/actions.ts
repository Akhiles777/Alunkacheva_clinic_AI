"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { inboxRecipients, notifyStaff } from "@/lib/server/notify";
import { humanTakeoverUntil } from "@/lib/agent/clinic-agent";
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
 * Диалоги инбокса — из доменных таблиц Conversation + Message. UI-поля (черновик
 * агента, таймер окна, причина эскалации, флаг «непрочитано») в схеме отсутствуют
 * — они остаются в клиентском сторе и сливаются по id при гидрации.
 */
export type DialogChannel = "instagram" | "whatsapp";
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

export async function getConversations(): Promise<DialogRecord[]> {
  const session = await getSession();
  const convs = await prisma.conversation.findMany({
    where: { companyId: session.companyId },
    orderBy: { lastMessageAt: "desc" },
    include: {
      patient: { select: { name: true } },
      messages: { orderBy: { createdAt: "asc" } },
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
    return {
      id: c.id,
      name: c.patient?.name ?? null,
      patientId: c.patientId,
      channel: c.channel === "INSTAGRAM" ? "instagram" : "whatsapp",
      status: STATUS_MAP[c.status],
      preview: last?.body ?? "",
      at: atLabel(c.lastMessageAt),
      messages,
    };
  });
}

export async function sendMessageDb(conversationId: string, messageId: string, text: string): Promise<void> {
  const session = await getSession();
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId: session.companyId },
    select: { channel: true },
  });
  if (!conv) return;
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
        body: text.trim(),
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

