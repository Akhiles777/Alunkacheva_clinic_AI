/**
 * Когда диалог возвращается агенту и когда пора напомнить о нём человеку.
 *
 * Два правила про один и тот же случай — «диалог ведёт сотрудник», — поэтому
 * лежат рядом и проверяются вместе. Оба чистые: ни базы, ни каналов, чтобы
 * границы можно было разобрать тестами, а не наблюдением за живой перепиской.
 */

/** Через сколько тишины диалог возвращается агенту. Решение заказчика. */
export const HANDBACK_HOURS = 24;

/** Через сколько без ответа напоминаем сотрудникам. */
export const REMIND_AFTER_MIN = 30;

/**
 * Сколько напоминаний по одному ожиданию — одно (решение заказчика).
 *
 * Напоминание должно быть событием, а не фоном: повторы об одном и том же
 * перестают читать, а вместе с ними перестают читать и новые. Диалог после
 * него всё равно виден в инбоксе с меткой «нужен ответ», а через сутки его
 * заберёт агент.
 */
export const MAX_REMINDERS = 1;

export interface WaitingDialog {
  /** Последнее сообщение переписки: чьё и когда. */
  last?: { direction: "IN" | "OUT"; createdAt: Date };
  /** Когда напомнили в прошлый раз. */
  remindedAt?: Date | null;
  /** Сколько напоминаний уже ушло по текущему ожиданию. */
  reminderCount?: number;
}

/**
 * Пора ли вернуть диалог агенту.
 *
 * Считаем от ПОСЛЕДНЕГО сообщения переписки, чьим бы оно ни было: сутки тишины
 * означают, что разговор закончился — и неважно, кто сказал последнее слово.
 *
 * Статус диалога проверяется снаружи: сюда доходят только те, что ведёт
 * человек. Закрытые не возвращаем — их закрыли намеренно.
 */
export function shouldHandBack(last: { createdAt: Date } | undefined, now: Date): boolean {
  if (!last) return false;
  return now.getTime() - last.createdAt.getTime() >= HANDBACK_HOURS * 3600_000;
}

/**
 * Пора ли напомнить сотрудникам о неотвеченном сообщении.
 *
 * Напоминаем, только пока последнее слово за пациентом: как только сотрудник
 * ответил, ожидание кончилось. Ровно один раз на ожидание — повторы об одном
 * и том же перестают читать.
 */
export function shouldRemind(dialog: WaitingDialog, now: Date): boolean {
  const last = dialog.last;
  if (!last || last.direction !== "IN") return false;

  const waiting = now.getTime() - last.createdAt.getTime();
  if (waiting < REMIND_AFTER_MIN * 60_000) return false;

  // Сутки прошли — напоминать поздно, диалог забирает агент.
  if (waiting >= HANDBACK_HOURS * 3600_000) return false;

  if ((dialog.reminderCount ?? 0) >= MAX_REMINDERS) return false;

  const since = dialog.remindedAt ? now.getTime() - dialog.remindedAt.getTime() : Infinity;
  return since >= REMIND_AFTER_MIN * 60_000;
}
