"use server";

import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import { requireId } from "@/lib/server/require-id";
import { answerAdmin, planBroadcast, type BroadcastPlan } from "@/lib/server/admin-assistant";
import { startDialogDb } from "./actions";

/**
 * Чат ассистента администратора — отдельный разговор в «Диалогах».
 *
 * Отвечает наш код по данным клиники (`lib/server/admin-assistant.ts`): числа
 * берутся из базы теми же правилами, что и на экранах, а переписка и
 * медицинские сведения во внешнюю модель не уходят (§7).
 *
 * Рассылка идёт в два шага и только так: сначала показать текст и поимённый
 * список, потом отправить по подтверждению. Ни одно сообщение отсюда не уходит
 * само — это единственная защита от «написал не тем».
 */

export interface AdminChatTurn {
  role: "user" | "assistant";
  text: string;
  /** У ответа с рассылкой — план: что уйдёт и кому. Хранится только на экране. */
  plan?: BroadcastPlan;
}

export interface AdminChatView {
  chatId: string;
  turns: AdminChatTurn[];
}

/** Ассистентом администратора пользуется тот, кто ведёт переписку с пациентами. */
async function chatSession() {
  const session = await getSession();
  if (!session.userId) throw new Error("Не удалось определить сотрудника");
  const [canMessage, canSeeRevenue] = await Promise.all([
    can(session, "MESSAGE_PATIENTS"),
    can(session, "VIEW_REVENUE"),
  ]);
  return { companyId: session.companyId, userId: session.userId, canMessage, canSeeRevenue };
}

/** Разговор один на сотрудника: это рабочий чат, а не список разборов. */
async function chatFor(companyId: string, userId: string): Promise<string> {
  const existing = await prisma.aiChat.findFirst({
    where: { companyId, userId, kind: "ADMIN", deletedAt: null },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.aiChat.create({
    data: { companyId, userId, kind: "ADMIN", title: "Ассистент администратора" },
    select: { id: true },
  });
  return created.id;
}

/** Последние реплики: чат переживает перезагрузку страницы и смену вкладки. */
export async function getAdminChat(): Promise<AdminChatView> {
  const { companyId, userId } = await chatSession();
  const chatId = await chatFor(companyId, userId);
  const rows = await prisma.aiChatMessage.findMany({
    where: { chatId },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { role: true, text: true },
  });
  return {
    chatId,
    turns: rows
      .reverse()
      .map((r) => ({ role: r.role === "USER" ? ("user" as const) : ("assistant" as const), text: r.text })),
  };
}

export async function askAdmin(question: string): Promise<AdminChatTurn> {
  const { companyId, userId, canMessage, canSeeRevenue } = await chatSession();
  const text = question.trim().slice(0, 2000);
  if (!text) return { role: "assistant", text: "Напишите вопрос — отвечу по данным клиники." };

  const answer = await answerAdmin(text, { companyId, canSeeRevenue, canMessage });

  const chatId = await chatFor(companyId, userId);
  await prisma.$transaction([
    prisma.aiChatMessage.createMany({
      data: [
        { chatId, role: "USER", text },
        { chatId, role: "ASSISTANT", text: answer.text },
      ],
    }),
    prisma.aiChat.update({ where: { id: chatId }, data: { lastMessageAt: new Date() } }),
  ]);

  return { role: "assistant", text: answer.text, plan: answer.plan };
}

export interface BroadcastResult {
  sent: number;
  failed: { name: string; reason: string }[];
  skipped: { name: string; reason: string }[];
  text: string;
}

/**
 * Сколько получателей у одной рассылки максимум.
 *
 * Не техническое ограничение, а защита: рассылка на весь день клиники — это
 * десятки сообщений, и промах здесь виден сразу всем. Больше предела —
 * администратор разбивает по врачам или дням и видит каждый список отдельно.
 */
const MAX_RECIPIENTS = 60;

/**
 * Отправить подготовленную рассылку.
 *
 * Список получателей пересчитывается ЗАНОВО по тем же условиям: между показом
 * и подтверждением проходят минуты, за которые запись могли отменить или
 * перенести. Экран присылает только условия и текст — подменить список
 * снаружи нельзя.
 */
export async function confirmBroadcast(input: {
  dayIso: string;
  staffId: string | null;
  serviceId: string | null;
  text: string;
}): Promise<BroadcastResult> {
  const { companyId, userId, canMessage, canSeeRevenue } = await chatSession();
  if (!canMessage) {
    return { sent: 0, failed: [], skipped: [], text: "Нет права писать пациентам." };
  }
  const body = input.text.trim();
  if (!body) return { sent: 0, failed: [], skipped: [], text: "Пустой текст — отправлять нечего." };

  const plan = await planBroadcast(
    { companyId, canSeeRevenue, canMessage },
    { dayIso: input.dayIso, staffId: input.staffId, serviceId: input.serviceId, text: body },
  );

  const skipped = plan.targets
    .filter((t) => t.blocked !== null)
    .map((t) => ({ name: t.name, reason: t.blocked as string }));
  const willSend = plan.targets.filter((t) => t.blocked === null).slice(0, MAX_RECIPIENTS);
  const overflow = plan.targets.filter((t) => t.blocked === null).length - willSend.length;

  const failed: { name: string; reason: string }[] = [];
  let sent = 0;
  for (const target of willSend) {
    /**
     * Отправляем тем же путём, что и «Написать» вручную: он находит
     * существующую переписку, заводит новую с настоящим адресом чата, отвечает
     * отказом там, где отправить нельзя, и помечает неудачу в самом сообщении.
     * Второго пути отправки в платформе нет и быть не должно (§5).
     */
    const res = await startDialogDb({
      id: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      channel: "whatsapp",
      patientId: target.patientId,
      message: body,
    }).catch((e: unknown) => ({
      ok: false as const,
      dialogId: null,
      error: (e as Error)?.message ?? "не удалось отправить",
    }));
    if (res.ok) sent += 1;
    else failed.push({ name: target.name, reason: res.error ?? "не ушло" });
  }

  /**
   * Рассылка — событие, о котором спросят: кто и кому написал. Отдельная
   * строка журнала на всю рассылку; каждое сообщение и так лежит в переписке.
   */
  await writeAudit({
    companyId,
    actorId: userId,
    action: "MESSAGE_SEND",
    entityType: "broadcast",
    entityId: plan.dayIso,
    meta: {
      staffId: plan.staffId,
      serviceId: plan.serviceId,
      recipients: willSend.length,
      sent,
      failed: failed.length,
    },
  }).catch(() => {
    // Журнал не должен мешать отправке: сообщения уже ушли.
  });

  const lines: string[] = [];
  lines.push(
    sent > 0
      ? `Отправлено ${sent} ${sent === 1 ? "пациенту" : "пациентам"}.`
      : "Не ушло ни одного сообщения.",
  );
  if (failed.length > 0) {
    lines.push(
      `Не ушло ${failed.length}: ` + failed.map((f) => `${f.name} — ${f.reason}`).join("; "),
    );
  }
  if (skipped.length > 0) {
    lines.push(
      `Пропущено ${skipped.length}: ` + skipped.map((s) => `${s.name} — ${s.reason}`).join("; "),
    );
  }
  if (overflow > 0) {
    lines.push(
      `Ещё ${overflow} получателей осталось за пределом одной рассылки (${MAX_RECIPIENTS}). ` +
        "Повторите запрос по врачу или по дню — список будет виден целиком.",
    );
  }

  const chatId = await chatFor(companyId, userId);
  const report = lines.join("\n");
  await prisma.$transaction([
    prisma.aiChatMessage.create({ data: { chatId, role: "ASSISTANT", text: report } }),
    prisma.aiChat.update({ where: { id: chatId }, data: { lastMessageAt: new Date() } }),
  ]);

  return { sent, failed, skipped, text: report };
}

/** Очистить переписку с ассистентом: это рабочий чат, он засоряется. */
export async function clearAdminChat(): Promise<void> {
  const { companyId, userId } = await chatSession();
  const chatId = await chatFor(companyId, userId);
  requireId(chatId, "разговор");
  await prisma.aiChatMessage.deleteMany({ where: { chatId } });
}
