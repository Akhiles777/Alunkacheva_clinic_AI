import { prisma } from "@/lib/db";
import { notifyStaff, escalationRecipients } from "@/lib/server/notify";
import { shouldHandBack, shouldRemind, HANDBACK_HOURS, REMIND_AFTER_MIN } from "./handback-rule";

/**
 * Диалоги, которые ведёт человек: вернуть агенту и напомнить о забытых.
 *
 * Два правила про одно и то же состояние, поэтому обходим их одним запросом.
 *
 *   1. Сутки тишины — разговор закончился, диалог возвращается агенту. Иначе
 *      переданный однажды диалог остаётся за человеком навсегда: пациент
 *      пишет через неделю с новым вопросом и не получает ответа, пока
 *      администратор не заметит.
 *   2. Пациент ждёт больше получаса — напоминаем. Первое уведомление ушло
 *      сразу, но оно теряется среди других; напоминание про конкретный
 *      неотвеченный диалог — то, ради чего всё и делается.
 *
 * Границы решений вынесены в handback-rule и проверены тестами: ошибка здесь
 * либо отдаёт агенту живой разговор с человеком, либо будит администратора
 * каждые пятнадцать минут.
 */

export interface HandbackResult {
  /** Диалогов возвращено агенту. */
  возвращено: number;
  /** Напоминаний отправлено. */
  напоминаний: number;
}

/** Сколько диалогов разбираем за круг: это подстраховка, а не нагрузка. */
const BATCH = 100;

export async function handBackAndRemind(companyId: string): Promise<HandbackResult> {
  const now = new Date();
  const result: HandbackResult = { возвращено: 0, напоминаний: 0 };

  const dialogs = await prisma.conversation.findMany({
    where: {
      companyId,
      // Закрытые не трогаем: их закрыли намеренно.
      status: { in: ["HUMAN_TAKEOVER", "ESCALATED"] },
    },
    orderBy: { lastMessageAt: "asc" },
    take: BATCH,
    select: {
      id: true,
      contactName: true,
      remindedAt: true,
      reminderCount: true,
      patient: { select: { name: true } },
      messages: {
        where: { deletedAt: null, isDraft: false },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { direction: true, createdAt: true },
      },
    },
  });

  for (const d of dialogs) {
    const last = d.messages[0];

    if (shouldHandBack(last, now)) {
      /**
       * Возврат агенту — одной транзакцией со снятием эскалации.
       *
       * Открытая эскалация означает «ждём человека»: если её оставить, добор
       * неотвеченных обойдёт диалог стороной, и агент, формально получив его
       * обратно, продолжит молчать. Хуже прежнего: статус говорит одно,
       * поведение другое.
       */
      await prisma.$transaction([
        prisma.conversation.update({
          where: { id: d.id },
          /**
           * Отметку о паузе НЕ снимаем: она осталась в прошлом и больше ничего
           * не запрещает, но служит границей «досюда разговор вёл человек».
           * По ней добор отличает новое сообщение от старого — иначе агент,
           * получив диалог обратно, отвечает на реплику четырёхчасовой
           * давности, на которую администратор уже ответил.
           */
          data: {
            status: "BOT_ACTIVE",
            remindedAt: null,
            reminderCount: 0,
          },
        }),
        prisma.escalation.updateMany({
          where: { conversationId: d.id, status: { not: "RESOLVED" } },
          data: { status: "RESOLVED", resolvedAt: now },
        }),
      ]);
      result.возвращено += 1;
      continue;
    }

    if (shouldRemind({ last, remindedAt: d.remindedAt, reminderCount: d.reminderCount }, now)) {
      const waitedMin = Math.round((now.getTime() - last!.createdAt.getTime()) / 60_000);
      const who = d.patient?.name?.trim() || d.contactName?.trim() || "Пациент";
      await notifyStaff({
        companyId,
        // Только администраторам — решение заказчика (§9).
        recipientIds: await escalationRecipients(companyId),
        kind: "ESCALATION",
        title: `${who} ждёт ответа ${waitedMin} мин`,
        body: "Диалог передан человеку, но ответа нет.",
        url: "/inbox",
        entityId: d.id,
      });
      await prisma.conversation.update({
        where: { id: d.id },
        data: { remindedAt: now, reminderCount: { increment: 1 } },
      });
      result.напоминаний += 1;
    }
  }

  return result;
}

export { HANDBACK_HOURS, REMIND_AFTER_MIN };
