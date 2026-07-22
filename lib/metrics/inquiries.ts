/**
 * Материализация обращений.
 *
 * Обращение — новый диалог, если предыдущее сообщение пациента было
 * ≥ 24 ч назад. Границу считаем только по сообщениям пациента: ответы бота
 * и администратора обращение не продлевают и новое не открывают, иначе
 * ночная рассылка напоминаний нарисует всплеск обращений.
 */

export const INQUIRY_GAP_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

export interface InquiryWindow {
  startedAt: Date;
  lastMessageAt: Date;
  messageCount: number;
}

/**
 * Режет поток входящих сообщений пациента на обращения.
 * Порядок сообщений на входе не важен — сортируем сами.
 */
export function splitIntoInquiries(
  patientMessageTimes: Date[],
  gapHours: number = INQUIRY_GAP_HOURS,
): InquiryWindow[] {
  const gapMs = gapHours * HOUR_MS;
  const ordered = [...patientMessageTimes].sort((a, b) => a.getTime() - b.getTime());

  const windows: InquiryWindow[] = [];
  for (const sentAt of ordered) {
    const current = windows[windows.length - 1];
    if (current && sentAt.getTime() - current.lastMessageAt.getTime() < gapMs) {
      current.lastMessageAt = sentAt;
      current.messageCount += 1;
    } else {
      windows.push({ startedAt: sentAt, lastMessageAt: sentAt, messageCount: 1 });
    }
  }

  return windows;
}

/**
 * Открывает ли новое входящее сообщение новое обращение.
 * `lastPatientMessageAt` — то самое поле Conversation, ради которого оно
 * хранится отдельно от lastMessageAt.
 */
export function startsNewInquiry(
  lastPatientMessageAt: Date | null | undefined,
  incomingAt: Date,
  gapHours: number = INQUIRY_GAP_HOURS,
): boolean {
  if (!lastPatientMessageAt) return true;
  return incomingAt.getTime() - lastPatientMessageAt.getTime() >= gapHours * HOUR_MS;
}

/** Обращения, попавшие в период [from, to). */
export function countInquiriesInPeriod(windows: InquiryWindow[], from: Date, to: Date): number {
  return windows.filter(
    (window) => window.startedAt >= from && window.startedAt < to,
  ).length;
}
