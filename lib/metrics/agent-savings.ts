/**
 * Сколько времени администраторов сэкономил агент.
 *
 * Самое опасное число во всей системе: посчитать себе в плюс тут проще всего.
 * Поэтому правила жёсткие и все — против нас.
 *
 * Формула:
 *
 *     экономия = Σ по темам ( закрыто_агентом[тема] × медиана_ручного[тема] )
 *
 * Медиана ручного ответа берётся из НАСТОЯЩИХ ручных ответов администраторов
 * на вопросы той же темы за последние 90 дней. Не из головы, не из константы.
 *
 * Три ограничения, без которых число становится рекламой:
 *
 *   1. Тема, по которой меньше пяти ручных ответов, в расчёт НЕ ИДЁТ. Считать
 *      по двум наблюдениям — это выдавать догадку за факт. Такие темы
 *      называются числом отдельно: «недостаточно данных для N тем».
 *   2. Рядом с экономией ВСЕГДА идёт встречное число: сколько эскалаций
 *      пришлось разобрать людям и сколько это заняло. Одна цифра без другой
 *      вводит владельца в заблуждение — агент, отдавший половину разговоров,
 *      «сэкономил» время, которое сам же и потратил чужими руками.
 *   3. Время ручного ответа обрезано сверху получасом. Дольше — это уже не
 *      время написания, а время, пока до сообщения дошли руки: приписывать
 *      его агенту нечестно.
 */

import { median } from "./agent";

/** Меньше этого числа наблюдений — базы для сравнения нет. */
export const MIN_SAMPLES = 5;
/** Ручной ответ дольше получаса — это ожидание, а не работа. */
export const MANUAL_CAP_MS = 30 * 60 * 1000;

export interface ManualAnswer {
  /** Тема справочника или «без темы». */
  topic: string;
  /** Время от вопроса пациента до ответа администратора, мс. */
  ms: number;
}

export interface ClosedByAgentByTopic {
  topic: string;
  count: number;
}

export interface TopicSaving {
  topic: string;
  closed: number;
  /** Медиана ручного ответа по теме, мс. */
  manualMedianMs: number;
  /** Сколько наблюдений легло в основу медианы. */
  samples: number;
  savedMs: number;
}

export interface SavingsReport {
  /** Итого сэкономлено, мс. */
  savedMs: number;
  byTopic: TopicSaving[];
  /** Темы, где базы для сравнения не хватило. Их вклад НЕ додумываем. */
  skippedTopics: { topic: string; closed: number; samples: number }[];
  /** Встречное число: сколько разговоров агент отдал людям. */
  escalations: number;
  /** И сколько времени люди на них потратили, мс. */
  escalationCostMs: number;
}

/**
 * Медианы ручного ответа по темам.
 *
 * Обрезка сверху делается ДО медианы: иначе один ответ через восемь часов
 * тянет медиану вверх на всей теме.
 */
export function manualMedians(answers: ManualAnswer[]): Map<string, { ms: number; samples: number }> {
  const byTopic = new Map<string, number[]>();
  for (const a of answers) {
    if (a.ms < 0) continue;
    const capped = Math.min(a.ms, MANUAL_CAP_MS);
    byTopic.set(a.topic, [...(byTopic.get(a.topic) ?? []), capped]);
  }

  const out = new Map<string, { ms: number; samples: number }>();
  for (const [topic, values] of byTopic) {
    const m = median(values);
    if (m !== null) out.set(topic, { ms: m, samples: values.length });
  }
  return out;
}

export function agentSavings(input: {
  closedByTopic: ClosedByAgentByTopic[];
  manual: ManualAnswer[];
  escalations: number;
  /** Время разбора эскалаций людьми, мс: сумма по разобранным. */
  escalationCostMs: number;
}): SavingsReport {
  const medians = manualMedians(input.manual);

  const byTopic: TopicSaving[] = [];
  const skippedTopics: SavingsReport["skippedTopics"] = [];

  for (const row of input.closedByTopic) {
    const base = medians.get(row.topic);
    if (!base || base.samples < MIN_SAMPLES) {
      // Базы для сравнения нет. Подставлять «среднее по больнице» нельзя:
      // получится правдоподобное число, за которым ничего не стоит.
      skippedTopics.push({ topic: row.topic, closed: row.count, samples: base?.samples ?? 0 });
      continue;
    }
    byTopic.push({
      topic: row.topic,
      closed: row.count,
      manualMedianMs: base.ms,
      samples: base.samples,
      savedMs: row.count * base.ms,
    });
  }

  byTopic.sort((a, b) => b.savedMs - a.savedMs);

  return {
    savedMs: byTopic.reduce((sum, t) => sum + t.savedMs, 0),
    byTopic,
    skippedTopics: skippedTopics.sort((a, b) => b.closed - a.closed),
    escalations: input.escalations,
    escalationCostMs: input.escalationCostMs,
  };
}
