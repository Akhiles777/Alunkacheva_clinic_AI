/**
 * Когда звать человека повторно.
 *
 * Пациент, приславший три сообщения подряд, не должен поднимать три
 * уведомления. Но глушить повторы по статусу диалога нельзя: статус
 * ESCALATED держится, пока сотрудник не вернёт диалог боту, и до тех пор
 * просьбы позвать администратора не доходили вообще — ни первая после
 * нажатия кнопки, ни все следующие.
 *
 * Поэтому решаем по времени и по поводу:
 *  · пациент прямо просит человека (или задал медицинский вопрос) — зовём,
 *    отсекая только мгновенный повтор, то есть двойную отправку;
 *  · агент решил сам (стоп-слово, не понял вопрос) — зовём не чаще раза в
 *    четверть часа, этого хватает, чтобы не заваливать администратора.
 */
export type EscalationReason =
  | "MEDICAL_QUESTION"
  | "PATIENT_REQUEST"
  | "KEYWORD"
  | "MISUNDERSTOOD"
  | "AGENT_REQUEST";

/** Просьбы, за которыми стоит человек, а не догадка агента. */
const EXPLICIT: EscalationReason[] = ["PATIENT_REQUEST", "AGENT_REQUEST", "MEDICAL_QUESTION"];

export const EXPLICIT_REPEAT_MS = 2 * 60_000;
export const AUTOMATIC_REPEAT_MS = 15 * 60_000;

export function isExplicit(reason: EscalationReason): boolean {
  return EXPLICIT.includes(reason);
}

export function shouldNotifyEscalation(input: {
  reason: EscalationReason;
  /** Когда в этом диалоге в последний раз звали человека. null — ещё ни разу. */
  lastEscalatedAt: Date | null;
  now: Date;
}): boolean {
  if (!input.lastEscalatedAt) return true;
  const passed = input.now.getTime() - input.lastEscalatedAt.getTime();
  // Время назад (расхождение часов) не должно превращаться в вечную тишину.
  if (passed < 0) return true;
  return passed >= (isExplicit(input.reason) ? EXPLICIT_REPEAT_MS : AUTOMATIC_REPEAT_MS);
}
