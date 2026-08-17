import { prisma } from "@/lib/db";

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

/**
 * Обращения за период — из базы, по тому же правилу 24 часов.
 *
 * Правило выше описано чистыми функциями и покрыто тестами, но в отчётах не
 * использовалось: воронка считала диалоги, начатые в периоде. Постоянная
 * пациентка, которая пишет каждый месяц в один и тот же чат, засчитывалась
 * один раз — в месяц первого сообщения. Отсюда «18 обращений за август» при
 * двадцати восьми переписках с сотнями сообщений.
 *
 * Считаем в базе, а не в памяти: сообщений у клиники полторы тысячи и растёт,
 * тянуть их в приложение ради подсчёта незачем. Логика та же, что в
 * splitIntoInquiries — разрыв ≥ 24 ч между соседними сообщениями пациента
 * открывает новое обращение.
 *
 * Предыдущее сообщение берётся без ограничения по дате: обращение первого
 * числа зависит от того, писал ли человек тридцать первого. Поэтому фильтр по
 * периоду стоит после оконной функции, а не внутри неё.
 */
export interface InquiryTotals {
  total: number;
  /** По источнику диалога; ключ null — источник не задан. */
  bySource: Map<string | null, number>;
}

export async function countInquiriesFromDb(
  companyId: string,
  from: Date,
  to: Date,
  gapHours: number = INQUIRY_GAP_HOURS,
): Promise<InquiryTotals> {
  const rows = await prisma.$queryRaw<{ sourceId: string | null; count: bigint }[]>`
    SELECT c."sourceId" AS "sourceId", COUNT(*) AS count
      FROM (
        SELECT m."conversationId",
               m."createdAt",
               LAG(m."createdAt") OVER (
                 PARTITION BY m."conversationId" ORDER BY m."createdAt"
               ) AS prev
          FROM messages m
         WHERE m."companyId" = ${companyId}
           AND m.direction = 'IN'
           AND m."deletedAt" IS NULL
           AND m."isDraft" = false
      ) t
      JOIN conversations c ON c.id = t."conversationId"
     WHERE t."createdAt" >= ${from}
       AND t."createdAt" < ${to}
       AND (t.prev IS NULL OR t."createdAt" - t.prev >= ${`${gapHours} hours`}::interval)
     GROUP BY c."sourceId"
  `;

  const bySource = new Map<string | null, number>();
  let total = 0;
  for (const row of rows) {
    const n = Number(row.count);
    bySource.set(row.sourceId, n);
    total += n;
  }
  return { total, bySource };
}
