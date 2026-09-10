"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { requireId } from "@/lib/server/require-id";
import { notifyStaff } from "@/lib/server/notify";
import { sendMessageDb } from "./actions";

/**
 * То, чего нет в WhatsApp: заметки, передача коллеге, отложенная отправка,
 * напоминания.
 *
 * Отдельным файлом от `actions.ts` не по размеру, а по смыслу: там всё, что
 * уходит ПАЦИЕНТУ, здесь — всё, что остаётся внутри клиники. Перепутать эти
 * две вещи один раз достаточно, чтобы служебная заметка «сомневается в цене»
 * ушла человеку, о котором она написана.
 */

export interface DialogNoteView {
  id: string;
  body: string;
  author: string | null;
  at: string;
}

const TIME_FMT = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

/** Заметки по диалогу — видны всем администраторам, пациенту никогда. */
export async function listDialogNotes(conversationId: string): Promise<DialogNoteView[]> {
  requireId(conversationId, "диалог");
  const session = await getSession();
  const rows = await prisma.dialogNote.findMany({
    where: { conversationId, companyId: session.companyId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, body: true, createdAt: true, author: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    author: r.author?.name ?? null,
    at: TIME_FMT.format(r.createdAt),
  }));
}

export async function addDialogNote(
  conversationId: string,
  body: string,
): Promise<{ ok: boolean; error?: string; note?: DialogNoteView }> {
  requireId(conversationId, "диалог");
  const session = await getSession();
  const text = body.trim();
  if (!text) return { ok: false, error: "Пустая заметка" };

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId: session.companyId },
    select: { id: true },
  });
  if (!conv) return { ok: false, error: "Диалог не найден" };

  const row = await prisma.dialogNote.create({
    data: {
      companyId: session.companyId,
      conversationId,
      authorId: session.userId,
      body: text.slice(0, 2000),
    },
    select: { id: true, body: true, createdAt: true, author: { select: { name: true } } },
  });
  return {
    ok: true,
    note: {
      id: row.id,
      body: row.body,
      author: row.author?.name ?? null,
      at: TIME_FMT.format(row.createdAt),
    },
  };
}

/** Убрать заметку. Мягко: сказанное коллегой не исчезает бесследно. */
export async function removeDialogNote(noteId: string): Promise<{ ok: boolean }> {
  requireId(noteId, "заметка");
  const session = await getSession();
  await prisma.dialogNote.updateMany({
    where: { id: noteId, companyId: session.companyId },
    data: { deletedAt: new Date() },
  });
  return { ok: true };
}

export interface ColleagueView {
  id: string;
  name: string;
  role: string;
}

/** Кому можно передать диалог: те, кто вообще пишет пациентам. */
export async function listColleagues(): Promise<ColleagueView[]> {
  const session = await getSession();
  const rows = await prisma.staffUser.findMany({
    where: {
      companyId: session.companyId,
      deletedAt: null,
      isActive: true,
      role: { in: ["OWNER", "ADMIN", "MANAGER"] },
      ...(session.userId ? { id: { not: session.userId } } : {}),
    },
    select: { id: true, name: true, role: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
}

/**
 * Передать диалог коллеге с комментарием.
 *
 * Комментарий обязателен: передача без него — это «разберись сам», то есть
 * та же работа заново. Ради него всё и делается: в переписке не написано
 * «уточни у Ирины Омаровны», а принимающему это нужно знать.
 *
 * Диалог закрепляется за принимающим (`assignedToId`) и уходит из «Мои» у
 * передающего — иначе смена сдана только на словах.
 */
export async function handoffDialog(
  conversationId: string,
  toId: string,
  comment: string,
): Promise<{ ok: boolean; error?: string }> {
  requireId(conversationId, "диалог");
  requireId(toId, "сотрудник");
  const session = await getSession();
  if (!(await can(session, "MESSAGE_PATIENTS"))) {
    return { ok: false, error: "Нет права писать пациентам" };
  }
  const text = comment.trim();
  if (!text) {
    return { ok: false, error: "Напишите, что коллеге сделать: без этого передача — та же работа заново." };
  }

  const [conv, to] = await Promise.all([
    prisma.conversation.findFirst({
      where: { id: conversationId, companyId: session.companyId },
      select: { id: true, contactName: true, patient: { select: { name: true } } },
    }),
    prisma.staffUser.findFirst({
      where: { id: toId, companyId: session.companyId, deletedAt: null, isActive: true },
      select: { id: true, name: true },
    }),
  ]);
  if (!conv) return { ok: false, error: "Диалог не найден" };
  if (!to) return { ok: false, error: "Сотрудник не найден" };

  await prisma.$transaction([
    prisma.dialogHandoff.create({
      data: {
        companyId: session.companyId,
        conversationId,
        fromId: session.userId,
        toId,
        comment: text.slice(0, 2000),
      },
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: { assignedToId: toId },
    }),
    /**
     * Комментарий передачи ложится и заметкой: заметки читают все, а история
     * передач — отдельный список, в который заглядывают редко. Написанное
     * при передаче не должно пропадать из виду разговора.
     */
    prisma.dialogNote.create({
      data: {
        companyId: session.companyId,
        conversationId,
        authorId: session.userId,
        body: `Передано ${to.name}: ${text.slice(0, 1800)}`,
      },
    }),
  ]);

  const who = conv.patient?.name ?? conv.contactName ?? "пациент";
  await notifyStaff({
    companyId: session.companyId,
    recipientIds: [toId],
    kind: "PATIENT_MESSAGE",
    title: `Вам передали диалог: ${who}`,
    body: text.slice(0, 160),
    url: `/inbox?d=${conversationId}`,
    entityId: conversationId,
  });

  return { ok: true };
}

export interface DialogTaskView {
  id: string;
  kind: "SEND" | "REMIND";
  body: string;
  runAt: string;
  /** Машинное время — по нему экран считает, сколько осталось. */
  runAtIso: string;
  status: string;
  failureReason: string | null;
}

export async function listDialogTasks(conversationId: string): Promise<DialogTaskView[]> {
  requireId(conversationId, "диалог");
  const session = await getSession();
  const rows = await prisma.dialogTask.findMany({
    where: { conversationId, companyId: session.companyId, status: { in: ["PENDING", "FAILED"] } },
    orderBy: { runAt: "asc" },
    select: {
      id: true,
      kind: true,
      body: true,
      runAt: true,
      status: true,
      failureReason: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    body: r.body,
    runAt: TIME_FMT.format(r.runAt),
    runAtIso: r.runAt.toISOString(),
    status: r.status,
    failureReason: r.failureReason,
  }));
}

/**
 * Отложить отправку или поставить напоминание.
 *
 * Время приходит с экрана готовым моментом (ISO): часовой пояс сотрудника и
 * сервера могут не совпадать, и «в 9 утра» обязано означать девять утра там,
 * где стоит человек.
 */
export async function scheduleDialogTask(input: {
  conversationId: string;
  kind: "SEND" | "REMIND";
  body: string;
  runAtIso: string;
  mediaIds?: string[];
  replyToId?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  requireId(input.conversationId, "диалог");
  const session = await getSession();
  if (!(await can(session, "MESSAGE_PATIENTS"))) {
    return { ok: false, error: "Нет права писать пациентам" };
  }
  const body = input.body.trim();
  if (!body) return { ok: false, error: "Пустой текст" };

  const runAt = new Date(input.runAtIso);
  if (Number.isNaN(runAt.getTime())) return { ok: false, error: "Не разобрали время" };
  if (runAt.getTime() < Date.now() + 30_000) {
    return { ok: false, error: "Время уже прошло — выберите будущее." };
  }

  const conv = await prisma.conversation.findFirst({
    where: { id: input.conversationId, companyId: session.companyId },
    select: { id: true },
  });
  if (!conv) return { ok: false, error: "Диалог не найден" };

  await prisma.dialogTask.create({
    data: {
      companyId: session.companyId,
      conversationId: input.conversationId,
      kind: input.kind,
      body: body.slice(0, 4000),
      mediaIds: input.mediaIds ?? [],
      replyToId: input.replyToId ?? null,
      runAt,
      createdById: session.userId,
    },
  });
  return { ok: true };
}

/** Отменить отложенное. Отменённое не исчезает: видно, что передумали. */
export async function cancelDialogTask(taskId: string): Promise<{ ok: boolean }> {
  requireId(taskId, "задача");
  const session = await getSession();
  await prisma.dialogTask.updateMany({
    where: { id: taskId, companyId: session.companyId, status: { in: ["PENDING", "FAILED"] } },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  return { ok: true };
}

/**
 * Выполнить назревшие отложенные дела.
 *
 * Зовётся из круга выгрузки, а не по таймеру в браузере: вкладку закрывают, а
 * сообщение, обещанное пациенту на девять утра, обязано уйти.
 *
 * Отправка идёт тем же кодом, что и ручная (`sendMessageDb`), — иначе у
 * отложенного сообщения была бы своя судьба: своя проверка канала, свои
 * ошибки и своя идемпотентность.
 */
export async function runDueDialogTasks(companyId: string): Promise<{ sent: number; failed: number }> {
  const due = await prisma.dialogTask.findMany({
    where: { companyId, status: "PENDING", kind: "SEND", runAt: { lte: new Date() } },
    orderBy: { runAt: "asc" },
    take: 20,
    /**
     * Автор задачи нужен для отправки: запроса здесь нет, сессии тоже, а у
     * сообщения пациенту всегда есть отправитель.
     */
    select: {
      id: true,
      conversationId: true,
      body: true,
      mediaIds: true,
      replyToId: true,
      createdById: true,
    },
  });

  let sent = 0;
  let failed = 0;
  for (const task of due) {
    /**
     * Помечаем задачу ДО отправки: круг выгрузки может пойти второй раз,
     * пока идёт первый, и пациент получит сообщение дважды. Неудачу
     * запишем следом.
     */
    const claimed = await prisma.dialogTask.updateMany({
      where: { id: task.id, status: "PENDING" },
      data: { status: "DONE", completedAt: new Date() },
    });
    if (claimed.count === 0) continue;

    const messageId = `task-${task.id}`;
    const res = await sendMessageDb(task.conversationId, messageId, task.body, {
      mediaIds: task.mediaIds,
      replyToMessageId: task.replyToId,
      /**
       * Отправляем от имени того, кто задачу поставил, и в его клинике.
       * Без этого `sendMessageDb` шёл за сессией, а её вне запроса нет:
       * задача падала с «cookies was called outside a request scope», и
       * обещанное пациенту сообщение молча оседало в «не ушло».
       */
      companyId,
      actorUserId: task.createdById,
    }).catch((e: unknown) => ({ ok: false, error: (e as Error)?.message ?? "сбой отправки" }));

    if (res.ok) {
      sent += 1;
      await prisma.dialogTask.update({
        where: { id: task.id },
        data: { resultMessageId: messageId },
      });
    } else {
      failed += 1;
      await prisma.dialogTask.update({
        where: { id: task.id },
        data: { status: "FAILED", completedAt: null, failureReason: res.error ?? "не отправлено" },
      });
    }
  }
  return { sent, failed };
}
