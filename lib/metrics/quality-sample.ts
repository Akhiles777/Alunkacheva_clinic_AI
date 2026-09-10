/**
 * Какие ответы агента проверять.
 *
 * Проверять все — дорого и незачем: большая часть ответов это адрес и часы
 * работы. Но есть ответы, цена ошибки в которых несоизмерима с их числом, и
 * они берутся полностью.
 *
 * Правило отбора живёт отдельно от самой проверки, потому что именно оно
 * решает, что мы вообще узнаем о качестве: выборка, собранная «как получится»,
 * покажет ровно то, что в неё случайно попало.
 */

export interface RunForSample {
  id: string;
  /** Медицинская тема — по эскалации или по словам вопроса. */
  medical: boolean;
  /** Пациент переспросил в ближайшие два часа: ответ не понят. */
  reasked: boolean;
  /** После ответа завелась эскалация. */
  escalated: boolean;
  /** Ответ ссылался на записи справочника. Пусто — ответ без основания. */
  knowledgeEntryIds: string[];
  /** Уже проверенный ответ второй раз не берём. */
  checked: boolean;
  /** Ответ удалён — проверять нечего. */
  deleted: boolean;
}

export type SampleReason = "medical" | "reasked" | "escalated" | "ungrounded" | "random";

export interface Sampled {
  runId: string;
  reason: SampleReason;
}

/** Сколько ответов берём за один прогон: проверка идёт ночью и порциями. */
export const SAMPLE_LIMIT = 40;
/** Какую долю «обычных» ответов берём случайно. */
export const RANDOM_SHARE = 0.1;

/**
 * Отбор.
 *
 * Порядок приоритетов — от того, что нельзя пропустить, к тому, что просто
 * полезно знать. Случайная выборка идёт последней и добирает остаток лимита:
 * без неё мы видели бы только те ответы, которые уже чем-то себя выдали.
 *
 * `pick` передаётся снаружи, чтобы прогон был воспроизводим в тесте: со
 * случайностью внутри проверить отбор нельзя.
 */
export function sampleRuns(
  runs: RunForSample[],
  limit: number = SAMPLE_LIMIT,
  pick: (index: number, total: number) => boolean = (i) => i % Math.round(1 / RANDOM_SHARE) === 0,
): Sampled[] {
  const usable = runs.filter((r) => !r.checked && !r.deleted);
  const out: Sampled[] = [];
  const taken = new Set<string>();

  const take = (list: RunForSample[], reason: SampleReason) => {
    for (const r of list) {
      if (out.length >= limit) return;
      if (taken.has(r.id)) continue;
      taken.add(r.id);
      out.push({ runId: r.id, reason });
    }
  };

  // Медицинские — все до одного: сочинённое противопоказание стоит здоровья.
  take(usable.filter((r) => r.medical), "medical");
  take(usable.filter((r) => r.escalated), "escalated");
  take(usable.filter((r) => r.reasked), "reasked");
  // Ответ без единой записи справочника — кандидат на «сказал от себя».
  take(usable.filter((r) => r.knowledgeEntryIds.length === 0), "ungrounded");

  const rest = usable.filter((r) => !taken.has(r.id));
  take(
    rest.filter((_, i) => pick(i, rest.length)),
    "random",
  );

  return out;
}

export type Verdict = "OK" | "DEVIATION" | "UNSUPPORTED_CLAIM" | "MEDICAL_WITHOUT_SOURCE" | "UNFINISHED";

/** Что означает каждый вердикт — теми же словами на экране и в отчёте. */
export const VERDICT_LABEL: Record<Verdict, string> = {
  OK: "всё по справке",
  DEVIATION: "отклонился от записи справочника",
  UNSUPPORTED_CLAIM: "сказал то, чего в справке нет",
  MEDICAL_WITHOUT_SOURCE: "медицинский ответ без основания",
  UNFINISHED: "не довёл разговор до конца",
};

/**
 * Разбор ответа проверяющей модели.
 *
 * Модель отвечает строкой вида «DEVIATION: назвал цену, которой нет». Не
 * распознали вердикт — считаем проверку несостоявшейся, а не «всё хорошо»:
 * молчаливое «OK» на непонятном ответе прячет ровно то, что мы ищем.
 */
export function parseVerdict(raw: string): { verdict: Verdict; comment: string } | null {
  const text = raw.trim();
  /**
   * `[\s\S]*` вместо флага `s`: цель сборки ниже es2018, и флаг там не
   * существует — регулярное выражение просто не компилируется.
   */
  const match = text.match(
    /^(OK|DEVIATION|UNSUPPORTED_CLAIM|MEDICAL_WITHOUT_SOURCE|UNFINISHED)(?![A-Za-z_])[:\s-]*([\s\S]*)$/i,
  );
  if (!match) return null;
  return {
    verdict: match[1].toUpperCase() as Verdict,
    comment: match[2].trim().slice(0, 600),
  };
}

/** Вердикты, требующие человека. «OK» в список проблем не идёт. */
export function needsReview(verdict: Verdict): boolean {
  return verdict !== "OK";
}
