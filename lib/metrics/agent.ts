/**
 * Метрики работы агента: надёжность, автономность, эскалации.
 *
 * Здесь только чистые расчёты над готовыми строками — база читается снаружи
 * (`lib/server/agent-stats.ts`). Так правило можно проверить тестами на
 * граничных случаях, не поднимая PostgreSQL, а экран не считает ничего сам.
 */

import type { AgentRunOutcome, EscalationReason } from "@/generated/prisma/enums";

// ─────────────────────────────────────────────────────────── надёжность

export interface AgentRunRow {
  id: string;
  conversationId: string;
  outcome: AgentRunOutcome;
  triggeredAt: Date;
  latencyMs: number | null;
  /** Ссылка на предыдущую попытку: строка — повтор после срыва. */
  retryOf: string | null;
}

export interface AgentReliability {
  /** Попытки, где агент действительно обращался к модели. */
  attempts: number;
  ok: number;
  timeout: number;
  providerError: number;
  emptyResponse: number;
  /** Доли от attempts, 0..1. Пусто при attempts = 0 — это не ноль (§3 правил). */
  okRate: number | null;
  timeoutRate: number | null;
  providerErrorRate: number | null;
  /** Медиана и 95-й перцентиль латентности удачных попыток, мс. */
  p50: number | null;
  p95: number | null;
  /** Сколько ответов спас повтор: удачная попытка, у которой есть предыдущая. */
  savedByRetry: number;
  /** Намеренное молчание. Считается отдельно и в надёжность не входит. */
  suppressed: number;
}

/**
 * Исходы, в которых агент обращался к модели.
 *
 * ESCALATED и SUPPRESSED сюда не входят: в первом случае вопрос по правилам
 * ушёл человеку, во втором агент молчал намеренно. Считать их отказами значит
 * записать в брак штатную работу.
 */
const MODEL_OUTCOMES: AgentRunOutcome[] = ["OK", "TIMEOUT", "PROVIDER_ERROR", "EMPTY_RESPONSE"];

export function agentReliability(rows: AgentRunRow[]): AgentReliability {
  const model = rows.filter((r) => MODEL_OUTCOMES.includes(r.outcome));
  const attempts = model.length;
  const count = (o: AgentRunOutcome) => model.filter((r) => r.outcome === o).length;

  const ok = count("OK");
  const timeout = count("TIMEOUT");
  const providerError = count("PROVIDER_ERROR");
  const emptyResponse = count("EMPTY_RESPONSE");

  const share = (n: number) => (attempts === 0 ? null : n / attempts);
  const latencies = model
    .filter((r) => r.outcome === "OK" && typeof r.latencyMs === "number")
    .map((r) => r.latencyMs as number);

  return {
    attempts,
    ok,
    timeout,
    providerError,
    emptyResponse,
    okRate: share(ok),
    timeoutRate: share(timeout),
    providerErrorRate: share(providerError),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    // Удачная попытка, у которой была предыдущая, — это спасённый ответ:
    // без повтора пациент получил бы «передаю администратору».
    savedByRetry: model.filter((r) => r.outcome === "OK" && r.retryOf !== null).length,
    suppressed: rows.filter((r) => r.outcome === "SUPPRESSED").length,
  };
}

/**
 * Перцентиль по методу ближайшего ранга.
 *
 * Пустой набор даёт null, а не ноль: «латентность 0 мс» — утверждение, которого
 * мы не делали. Один элемент — он сам. Чётное количество усредняем: медиана
 * четырёх чисел лежит между вторым и третьим, и округлять её к одному из них
 * значит врать на половину шага.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];

  const pos = ((sorted.length - 1) * p) / 100;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower));
}

/** Медиана — то же самое, названное своим именем: её спрашивают чаще всего. */
export function median(values: number[]): number | null {
  return percentile(values, 50);
}

// ─────────────────────────────────────────────────────────── автономность

export interface AutonomyDialog {
  conversationId: string;
  /** Последний ответ агента в периоде. */
  agentRepliedAt: Date;
  /** Первое сообщение сотрудника после ответа агента, если было. */
  staffRepliedAt: Date | null;
  /** Первая эскалация после ответа агента, если была. */
  escalatedAt: Date | null;
  /** Следующее сообщение пациента после ответа агента, если было. */
  patientRepliedAt: Date | null;
}

export interface AgentAutonomy {
  /** Диалоги, где агент вообще отвечал в периоде. */
  total: number;
  closedByAgent: number;
  wentToHuman: number;
  /** Доля закрытых агентом, 0..1. Пусто при total = 0. */
  rate: number | null;
}

/** Сколько ждём вмешательства человека, прежде чем считать тему закрытой. */
export const HUMAN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Повторный вопрос пациента в этот срок означает, что тема не закрыта. */
export const PATIENT_FOLLOWUP_MS = 2 * 60 * 60 * 1000;

/**
 * Закрыл ли агент разговор сам.
 *
 * Это принципиально не «агент ответил». Агент, ответивший невпопад и
 * вызвавший три уточнения, в наивной метрике выглядит успешным — здесь нет.
 * Все четыре условия обязательны:
 *
 *   1. агент отвечал в периоде;
 *   2. в сутки после этого не написал сотрудник;
 *   3. в сутки после этого не создана эскалация;
 *   4. пациент не переспросил в ближайшие два часа.
 */
export function closedByAgent(d: AutonomyDialog): boolean {
  const at = d.agentRepliedAt.getTime();

  const within = (when: Date | null, windowMs: number) =>
    when !== null && when.getTime() > at && when.getTime() - at <= windowMs;

  if (within(d.staffRepliedAt, HUMAN_WINDOW_MS)) return false;
  if (within(d.escalatedAt, HUMAN_WINDOW_MS)) return false;
  if (within(d.patientRepliedAt, PATIENT_FOLLOWUP_MS)) return false;
  return true;
}

export function agentAutonomy(dialogs: AutonomyDialog[]): AgentAutonomy {
  const total = dialogs.length;
  const closed = dialogs.filter(closedByAgent).length;
  return {
    total,
    closedByAgent: closed,
    wentToHuman: total - closed,
    rate: total === 0 ? null : closed / total,
  };
}

// ─────────────────────────────────────────────────────────── эскалации

export interface EscalationRow {
  reason: EscalationReason;
  createdAt: Date;
  acknowledgedAt: Date | null;
}

export interface EscalationSlice {
  reason: EscalationReason;
  count: number;
  /** Доля от всех эскалаций периода, 0..1. */
  share: number;
  /** Медиана времени до разбора, мс. Пусто — ни одной разобранной. */
  medianToAckMs: number | null;
  /** Сколько так и не разобрали. */
  unresolved: number;
}

export function escalationBreakdown(rows: EscalationRow[]): EscalationSlice[] {
  const byReason = new Map<EscalationReason, EscalationRow[]>();
  for (const r of rows) {
    byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r]);
  }

  return [...byReason.entries()]
    .map(([reason, list]) => {
      const acked = list
        .filter((r) => r.acknowledgedAt !== null)
        .map((r) => (r.acknowledgedAt as Date).getTime() - r.createdAt.getTime())
        // Разбор «раньше создания» — рассинхрон часов, а не мгновенная реакция.
        .filter((ms) => ms >= 0);
      return {
        reason,
        count: list.length,
        share: rows.length === 0 ? 0 : list.length / rows.length,
        medianToAckMs: median(acked),
        unresolved: list.filter((r) => r.acknowledgedAt === null).length,
      };
    })
    .sort((a, b) => b.count - a.count);
}
