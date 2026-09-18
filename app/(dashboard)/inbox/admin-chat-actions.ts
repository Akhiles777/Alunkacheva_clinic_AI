"use server";

import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import { requireId } from "@/lib/server/require-id";
import { answerAdmin, planBroadcast, type BroadcastPlan } from "@/lib/server/admin-assistant";
import { startDialogDb } from "./actions";
import { scheduleDialogTask } from "./dialog-actions";

/** «19 сентября в 09:00» — как момент отправки читает человек. */
const WHEN = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

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
  const [canMessage, canSeeRevenue, canViewOthers] = await Promise.all([
    can(session, "MESSAGE_PATIENTS"),
    can(session, "VIEW_REVENUE"),
    can(session, "VIEW_OTHER_PATIENTS"),
  ]);
  /**
   * Кто он в справочнике сотрудников: врачу ассистент отвечает только про его
   * приёмы, и подставлять специалиста нужно самому — по учётке, а не по слову
   * в вопросе.
   */
  const me = await prisma.staffUser.findUnique({
    where: { id: session.userId },
    select: { staffId: true },
  });
  return {
    companyId: session.companyId,
    userId: session.userId,
    canMessage,
    canSeeRevenue,
    canViewOthers,
    ownStaffId: me?.staffId ?? null,
  };
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
  const { companyId, userId, canMessage, canSeeRevenue, canViewOthers, ownStaffId } =
    await chatSession();
  const text = question.trim().slice(0, 2000);
  if (!text) return { role: "assistant", text: "Напишите вопрос — отвечу по данным клиники." };

  const answer = await answerAdmin(text, {
    companyId,
    canSeeRevenue,
    canMessage,
    canViewOthers,
    ownStaffId,
  });

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
 * Насколько вперёд можно отложить отправку.
 *
 * Месяц — предел здравого смысла: за это время запись отменят, перенесут или
 * человек уже придёт, а сообщение всё равно уйдёт. Дальше — это не отложенная
 * отправка, а забытое обещание.
 */
const MAX_DELAY_DAYS = 30;

/**
 * Не отправлять один и тот же текст одному человеку дважды подряд.
 *
 * Кнопку подтверждения нажимают дважды чаще, чем кажется: связь подвисла,
 * экран не ответил, человек нажал ещё раз. Для рассылки это значит, что
 * десятки пациентов получат одно и то же дважды, и виноватой выглядит клиника.
 */
const DOUBLE_SEND_WINDOW_MS = 10 * 60_000;

async function alreadyGot(
  companyId: string,
  patientIds: string[],
  body: string,
): Promise<Set<string>> {
  if (patientIds.length === 0) return new Set();
  const rows = await prisma.message.findMany({
    where: {
      companyId,
      direction: "OUT",
      body,
      createdAt: { gte: new Date(Date.now() - DOUBLE_SEND_WINDOW_MS) },
      conversation: { patientId: { in: patientIds } },
    },
    select: { conversation: { select: { patientId: true } } },
  });
  return new Set(
    rows.map((r) => r.conversation?.patientId).filter((id): id is string => Boolean(id)),
  );
}

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
  /** Одному пациенту — кому именно; пусто — рассылка записанным. */
  patientId?: string | null;
  /** Когда отправить; пусто — сразу. Исполняет отложенное сервер (`DialogTask`). */
  sendAtIso?: string | null;
}): Promise<BroadcastResult> {
  const { companyId, userId, canMessage, canSeeRevenue } = await chatSession();
  if (!canMessage) {
    return { sent: 0, failed: [], skipped: [], text: "Нет права писать пациентам." };
  }
  const body = input.text.trim();
  if (!body) return { sent: 0, failed: [], skipped: [], text: "Пустой текст — отправлять нечего." };

  if (input.sendAtIso) {
    const at = new Date(input.sendAtIso);
    if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + MAX_DELAY_DAYS * 24 * 3600 * 1000) {
      return {
        sent: 0,
        failed: [],
        skipped: [],
        text: `Так далеко отложить нельзя — предел ${MAX_DELAY_DAYS} суток. За месяц запись успеет измениться.`,
      };
    }
  }

  /**
   * Письмо одному пациенту — отдельная дорога: пересчитывать список не нужно,
   * адресат назван прямо, и он же показан администратору на экране.
   */
  if (input.patientId) {
    return sendToOne({ companyId, userId }, input.patientId, body, input.sendAtIso ?? null);
  }

  const plan = await planBroadcast(
    { companyId, canSeeRevenue, canMessage },
    { dayIso: input.dayIso, staffId: input.staffId, serviceId: input.serviceId, text: body },
  );

  const skipped = plan.targets
    .filter((t) => t.blocked !== null)
    .map((t) => ({ name: t.name, reason: t.blocked as string }));

  /** Кому этот же текст уже ушёл минуту назад — второй раз не отправляем. */
  const got = await alreadyGot(
    companyId,
    plan.targets.filter((t) => t.blocked === null).map((t) => t.patientId),
    body,
  );
  for (const t of plan.targets) {
    if (t.blocked === null && got.has(t.patientId)) {
      skipped.push({ name: t.name, reason: "это сообщение ему уже ушло только что" });
    }
  }
  const willSend = plan.targets
    .filter((t) => t.blocked === null && !got.has(t.patientId))
    .slice(0, MAX_RECIPIENTS);
  const overflow =
    plan.targets.filter((t) => t.blocked === null && !got.has(t.patientId)).length - willSend.length;

  /**
   * Отложенная рассылка: каждому — своя задача в его переписке, её исполнит
   * круг выгрузки (§5). Тем, с кем переписки ещё нет, отложить нельзя: задача
   * живёт на диалоге, а диалог заводится только отправкой. Такие получатели
   * попадают в «пропущено» с причиной — молча терять их нельзя.
   */
  if (input.sendAtIso) {
    return scheduleForAll({ companyId, userId }, willSend, body, input.sendAtIso, skipped, overflow);
  }

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

/**
 * Написать одному пациенту — сейчас или в назначенное время.
 *
 * Оба пути — те же, что у администратора вручную: отправка через
 * `startDialogDb`, отложенная через `scheduleDialogTask` (её исполняет сервер,
 * а не вкладка). Ассистент не заводит собственной отправки: второй путь
 * означал бы вторые правила о том, что уходит пациенту (§5).
 */
async function sendToOne(
  who: { companyId: string; userId: string },
  patientId: string,
  body: string,
  sendAtIso: string | null,
): Promise<BroadcastResult> {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, companyId: who.companyId, deletedAt: null },
    select: { name: true },
  });
  const name = patient?.name ?? "пациент";

  /** Тот же текст этому же человеку минуту назад — повтор, а не новое письмо. */
  if (!sendAtIso && (await alreadyGot(who.companyId, [patientId], body)).has(patientId)) {
    return {
      sent: 0,
      failed: [],
      skipped: [{ name, reason: "это сообщение ему уже ушло только что" }],
      text: `Не отправил: это же сообщение ушло ${name} только что. Если нужно повторить — измените текст.`,
    };
  }

  if (sendAtIso) {
    const dialog = await prisma.conversation.findFirst({
      where: {
        companyId: who.companyId,
        patientId,
        deletedAt: null,
        NOT: { externalUserId: { startsWith: "local-" } },
      },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true },
    });
    if (!dialog) {
      return {
        sent: 0,
        failed: [],
        skipped: [{ name, reason: "переписки ещё нет — отложить некуда, можно отправить сразу" }],
        text: `Отложить не получилось: переписки с ${name} ещё нет. Могу отправить сразу.`,
      };
    }
    const res = await scheduleDialogTask({
      conversationId: dialog.id,
      kind: "SEND",
      body,
      runAtIso: sendAtIso,
    });
    if (!res.ok) {
      return {
        sent: 0,
        failed: [{ name, reason: res.error ?? "не удалось отложить" }],
        skipped: [],
        text: `Не отложилось: ${res.error ?? "причина не записана"}.`,
      };
    }
    await writeAudit({
      companyId: who.companyId,
      actorId: who.userId,
      action: "MESSAGE_SEND",
      entityType: "scheduled",
      entityId: patientId,
      meta: { runAt: sendAtIso },
    }).catch(() => {});
    return {
      sent: 0,
      failed: [],
      skipped: [],
      text: `Готово: сообщение уйдёт ${WHEN.format(new Date(sendAtIso))} — ${name}. Отменить можно в переписке, в «Отложить».`,
    };
  }

  const res = await startDialogDb({
    id: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    channel: "whatsapp",
    patientId,
    message: body,
  }).catch((e: unknown) => ({
    ok: false as const,
    dialogId: null,
    error: (e as Error)?.message ?? "не удалось отправить",
  }));

  await writeAudit({
    companyId: who.companyId,
    actorId: who.userId,
    action: "MESSAGE_SEND",
    entityType: "assistant",
    entityId: patientId,
    meta: { ok: res.ok },
  }).catch(() => {});

  return res.ok
    ? { sent: 1, failed: [], skipped: [], text: `Отправлено — ${name}.` }
    : {
        sent: 0,
        failed: [{ name, reason: res.error ?? "не ушло" }],
        skipped: [],
        text: `Не ушло — ${name}: ${res.error ?? "причина не записана"}.`,
      };
}

/** Отложенная рассылка: задача в каждой переписке, исполняет сервер. */
async function scheduleForAll(
  who: { companyId: string; userId: string },
  targets: { patientId: string; name: string }[],
  body: string,
  sendAtIso: string,
  skipped: { name: string; reason: string }[],
  overflow: number,
): Promise<BroadcastResult> {
  const dialogs = await prisma.conversation.findMany({
    where: {
      companyId: who.companyId,
      patientId: { in: targets.map((t) => t.patientId) },
      deletedAt: null,
      NOT: { externalUserId: { startsWith: "local-" } },
    },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true, patientId: true },
  });
  const byPatient = new Map(dialogs.map((d) => [d.patientId, d.id]));

  const failed: { name: string; reason: string }[] = [];
  const noDialog: { name: string; reason: string }[] = [];
  let planned = 0;
  for (const t of targets) {
    const conversationId = byPatient.get(t.patientId);
    if (!conversationId) {
      noDialog.push({ name: t.name, reason: "переписки ещё нет — отложить некуда" });
      continue;
    }
    const res = await scheduleDialogTask({ conversationId, kind: "SEND", body, runAtIso: sendAtIso });
    if (res.ok) planned += 1;
    else failed.push({ name: t.name, reason: res.error ?? "не отложилось" });
  }

  await writeAudit({
    companyId: who.companyId,
    actorId: who.userId,
    action: "MESSAGE_SEND",
    entityType: "scheduled-broadcast",
    entityId: sendAtIso,
    meta: { planned, failed: failed.length },
  }).catch(() => {});

  const lines = [
    planned > 0
      ? `Отложено ${planned} ${planned === 1 ? "сообщение" : "сообщений"} на ${WHEN.format(new Date(sendAtIso))}.`
      : "Отложить не удалось ни одного сообщения.",
  ];
  if (noDialog.length > 0) {
    lines.push(
      `Без переписки ${noDialog.length}: ${noDialog.map((n) => n.name).join(", ")} — им можно только отправить сразу.`,
    );
  }
  if (failed.length > 0) {
    lines.push(`Не отложилось ${failed.length}: ${failed.map((f) => `${f.name} — ${f.reason}`).join("; ")}`);
  }
  if (skipped.length > 0) {
    lines.push(`Пропущено ${skipped.length}: ${skipped.map((s) => `${s.name} — ${s.reason}`).join("; ")}`);
  }
  if (overflow > 0) lines.push(`Ещё ${overflow} осталось за пределом одной рассылки.`);
  return { sent: planned, failed, skipped: [...skipped, ...noDialog], text: lines.join("\n") };
}

/** Очистить переписку с ассистентом: это рабочий чат, он засоряется. */
export async function clearAdminChat(): Promise<void> {
  const { companyId, userId } = await chatSession();
  const chatId = await chatFor(companyId, userId);
  requireId(chatId, "разговор");
  await prisma.aiChatMessage.deleteMany({ where: { chatId } });
}
