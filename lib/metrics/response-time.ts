/**
 * За сколько отвечаем пациенту.
 *
 * Везде МЕДИАНА, а не среднее. Одно ночное сообщение с ответом через двенадцать
 * часов сдвигает среднее так, что реальная картина исчезает: «отвечаем за 4
 * часа» при том, что девять из десяти получают ответ за две минуты. Среднее
 * показываем рядом вторым числом — оно тоже о чём-то говорит, но не о типичном
 * случае.
 *
 * Чистые функции: база читается снаружи, здесь только правило.
 */

import { median } from "./agent";

export type Responder = "AGENT" | "STAFF";

export interface DialogMessage {
  conversationId: string;
  direction: "IN" | "OUT";
  authorType: "PATIENT" | "BOT" | "STAFF";
  createdAt: Date;
  /** Канал переписки — для разреза. */
  channel: string;
  /** Кто из сотрудников ответил, если ответ ручной. */
  staffUserId?: string | null;
}

/** Рабочие часы клиники по дням недели: 1 — понедельник, 7 — воскресенье. */
export interface WorkingHours {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface FirstResponse {
  conversationId: string;
  responder: Responder;
  /** Пришёл ли вопрос в рабочие часы клиники. */
  duringWorkingHours: boolean;
  channel: string;
  staffUserId: string | null;
  ms: number;
}

export interface FirstResponseStats {
  /** Медиана, мс. Пусто — отвечать было не на что. */
  medianMs: number | null;
  /** Среднее, мс. Показываем рядом с медианой, мельче. */
  meanMs: number | null;
  count: number;
}

export interface FirstResponseReport {
  agent: FirstResponseStats;
  staffWorkingHours: FirstResponseStats;
  staffAfterHours: FirstResponseStats;
  /** Обращения, оставшиеся без ответа вовсе. В медиану не входят. */
  unanswered: number;
  /** Отброшенные аномалии: ответ раньше вопроса (рассинхрон часов провайдера). */
  anomalies: number;
  byChannel: { channel: string; responder: Responder; stats: FirstResponseStats }[];
  byStaff: { staffUserId: string; stats: FirstResponseStats }[];
}

function statsOf(values: number[]): FirstResponseStats {
  if (values.length === 0) return { medianMs: null, meanMs: null, count: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    medianMs: median(values),
    meanMs: Math.round(sum / values.length),
    count: values.length,
  };
}

/**
 * Попадает ли момент в рабочие часы клиники.
 *
 * График берём из настроек, а не из константы: клиника работает 08:00–16:00,
 * а зашитые 9–21 объявили бы вечерний ответ «в рабочее время» и спрятали бы
 * настоящую задержку.
 */
export function isWorkingTime(at: Date, schedule: WorkingHours[], tz = "Europe/Moscow"): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);

  const dayName = parts.find((p) => p.type === "weekday")?.value ?? "";
  const order: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const weekday = order[dayName];
  if (!weekday) return false;

  const minute =
    Number(parts.find((p) => p.type === "hour")?.value ?? "0") * 60 +
    Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  return schedule.some(
    (d) => d.weekday === weekday && minute >= d.startMinute && minute < d.endMinute,
  );
}

/**
 * Первый ответ на обращение пациента.
 *
 * Граничные случаи разобраны явно — каждый из них однажды дал бы неверное
 * число:
 *
 *   — диалог начат исходящим сообщением клиники: отвечать было не на что,
 *     в метрику не идёт;
 *   — несколько сообщений пациента подряд: отсчёт от ПЕРВОГО, иначе рассылка
 *     из трёх реплик выглядит как три быстрых ответа;
 *   — сообщение без ответа вовсе: в медиану не входит, считается отдельно —
 *     иначе молчание улучшало бы показатель;
 *   — ответ раньше вопроса: рассинхрон часов провайдера, отбрасываем и
 *     называем числом.
 */
export function firstResponses(
  messages: DialogMessage[],
  schedule: WorkingHours[],
): { responses: FirstResponse[]; unanswered: number; anomalies: number } {
  const byDialog = new Map<string, DialogMessage[]>();
  for (const m of messages) {
    byDialog.set(m.conversationId, [...(byDialog.get(m.conversationId) ?? []), m]);
  }

  const responses: FirstResponse[] = [];
  let unanswered = 0;
  let anomalies = 0;

  for (const [conversationId, list] of byDialog) {
    const ordered = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // Пары «вопрос — первый ответ на него». Серия сообщений пациента подряд
    // считается одним обращением: отсчёт от первого.
    let pending: DialogMessage | null = null;
    for (const m of ordered) {
      if (m.direction === "IN") {
        if (pending === null) pending = m;
        continue;
      }
      if (pending === null) continue; // исходящее без вопроса — не ответ

      const ms = m.createdAt.getTime() - pending.createdAt.getTime();
      if (ms < 0) {
        anomalies += 1;
        pending = null;
        continue;
      }
      responses.push({
        conversationId,
        responder: m.authorType === "BOT" ? "AGENT" : "STAFF",
        duringWorkingHours: isWorkingTime(pending.createdAt, schedule),
        channel: m.channel,
        staffUserId: m.authorType === "STAFF" ? (m.staffUserId ?? null) : null,
        ms,
      });
      pending = null;
    }
    // Последнее слово осталось за пациентом — обращение без ответа.
    if (pending !== null) unanswered += 1;
  }

  return { responses, unanswered, anomalies };
}

export function firstResponseTime(
  messages: DialogMessage[],
  schedule: WorkingHours[],
): FirstResponseReport {
  const { responses, unanswered, anomalies } = firstResponses(messages, schedule);
  const pick = (fn: (r: FirstResponse) => boolean) => statsOf(responses.filter(fn).map((r) => r.ms));

  const channels = [...new Set(responses.map((r) => r.channel))];
  const byChannel = channels.flatMap((channel) =>
    (["AGENT", "STAFF"] as Responder[])
      .map((responder) => ({
        channel,
        responder,
        stats: pick((r) => r.channel === channel && r.responder === responder),
      }))
      .filter((x) => x.stats.count > 0),
  );

  const staffIds = [...new Set(responses.map((r) => r.staffUserId).filter((x): x is string => !!x))];

  return {
    agent: pick((r) => r.responder === "AGENT"),
    staffWorkingHours: pick((r) => r.responder === "STAFF" && r.duringWorkingHours),
    staffAfterHours: pick((r) => r.responder === "STAFF" && !r.duringWorkingHours),
    unanswered,
    anomalies,
    byChannel,
    byStaff: staffIds.map((staffUserId) => ({
      staffUserId,
      stats: pick((r) => r.staffUserId === staffUserId),
    })),
  };
}

/**
 * Сколько администратор идёт к эскалации.
 *
 * Это метрика администратора и работоспособности push, а не качества агента:
 * агент своё дело сделал, когда позвал человека.
 */
export interface EscalationTiming {
  notifiedAt: Date | null;
  acknowledgedAt: Date | null;
}

export function escalationResponseTime(rows: EscalationTiming[]): FirstResponseStats & {
  unacknowledged: number;
} {
  const values: number[] = [];
  let unacknowledged = 0;
  for (const r of rows) {
    if (r.notifiedAt === null) continue;
    if (r.acknowledgedAt === null) {
      unacknowledged += 1;
      continue;
    }
    const ms = r.acknowledgedAt.getTime() - r.notifiedAt.getTime();
    if (ms >= 0) values.push(ms);
  }
  return { ...statsOf(values), unacknowledged };
}
