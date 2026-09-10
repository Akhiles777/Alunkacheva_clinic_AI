import { deviationOf, tooQuiet, type Deviation, type DeviationDirection } from "./deviation";

/**
 * Из недельных рядов — в три-пять наблюдений.
 *
 * Это не дашборд и не список метрик: владелец читает сводку по понедельникам
 * минуту, и её задача — назвать то, на что стоит посмотреть, а не пересказать
 * всё, что мы умеем считать. Поэтому наблюдений не больше пяти, и попадают в
 * них только те метрики, которые вышли за собственный разброс клиники.
 *
 * Гипотеза о причине выдаётся ТОЛЬКО когда её подпирает второе измеренное
 * число. Дежурная фраза «возможно, из-за сезонности» звучит осмысленно, ничего
 * не объясняет и уводит от разбора: владелец прочитает объяснение и не пойдёт
 * смотреть. Нет второго числа — гипотезы нет, и это честнее.
 */

export type Unit = "money" | "count" | "percent" | "minutes";

export interface MetricSeries {
  key: string;
  /** Как метрика называется владельцу. */
  title: string;
  /** Предыдущие недели, от старой к свежей. Текущая сюда не входит. */
  history: number[];
  current: number;
  unit: Unit;
  /** Ниже этой разницы метрику не обсуждаем: у каждой свой масштаб. */
  minAbsolute: number;
  /** Куда идти смотреть. */
  href: string;
  /**
   * Что здесь считается ухудшением. Неявки вверх — плохо, выручка вверх —
   * хорошо, у загрузки кабинета ответа нет. Нужно только для интонации.
   */
  worseWhen: DeviationDirection | null;
  /** Уточнение, без которого число читается неверно (например, §8). */
  note?: string;
}

export interface Observation {
  key: string;
  title: string;
  /** Факт: число и то, как оно отличается от обычного. */
  text: string;
  /** Догадка о причине — отдельным полем, чтобы не слипалась с фактом. */
  hypothesis: string | null;
  note: string | null;
  href: string;
  score: number;
  direction: DeviationDirection;
  worse: boolean;
}

export interface DigestInput {
  series: MetricSeries[];
  /** Приёмов на неделе и по неделям истории — для проверки «неделя пустая». */
  appointments: number;
  appointmentsHistory: number[];
}

export interface Digest {
  observations: Observation[];
  /**
   * Почему наблюдений нет или почему их нельзя сравнивать. Пустая строка не
   * годится: «ничего не нашли» и «сравнивать было не с чем» — разные вещи.
   */
  note: string | null;
  /** Есть ли вообще база для сравнения (8 полных недель). */
  hasBaseline: boolean;
}

/** Сколько наблюдений показываем. Больше пяти уже не читают. */
export const MAX_OBSERVATIONS = 5;

const nbsp = (n: number) => n.toLocaleString("ru-RU");

/**
 * Гипотеза с заглавной буквы — и без второго «возможно».
 *
 * Оговорка встроена в саму гипотезу: приписывать её ещё и снаружи значит
 * получить «Возможно, приёмов столько же — возможно, дело в составе услуг».
 * Место оговорки одно, и оно там, где написана гипотеза.
 */
export function capitalizeFirst(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

export function formatValue(value: number, unit: Unit): string {
  switch (unit) {
    case "money":
      return `${nbsp(Math.round(value))} ₽`;
    case "percent":
      return `${Math.round(value * 10) / 10}%`;
    case "minutes":
      return `${Math.round(value)} мин`;
    default:
      return nbsp(Math.round(value * 10) / 10);
  }
}

/**
 * Гипотезы, подпёртые вторым числом.
 *
 * Каждая ветка здесь опирается на другую ИЗМЕРЕННУЮ метрику той же недели.
 * Ничего «вообще» и ничего про сезонность: такое объяснение подходит к любой
 * неделе и потому не значит ничего.
 */
function hypothesisFor(
  key: string,
  d: Deviation,
  all: Map<string, Deviation>,
): string | null {
  const other = (k: string) => all.get(k) ?? null;

  if (key === "revenue" && d.direction === "down") {
    const visits = other("arrived");
    if (visits && visits.notable && visits.direction === "down") {
      return "приёмов тоже меньше обычного — возможно, дело в потоке пациентов, а не в ценах";
    }
    if (visits && !visits.notable) {
      return "приёмов при этом столько же, сколько обычно — возможно, дело в составе услуг, а не в потоке";
    }
    return null;
  }

  if (key === "firstResponse" && d.direction === "up") {
    const inq = other("inquiries");
    if (inq && inq.notable && inq.direction === "up") {
      return "обращений на неделе больше обычного — возможно, просто не успевали отвечать";
    }
    return null;
  }

  if (key === "noShow" && d.direction === "up") {
    const unmarked = other("unmarked");
    if (unmarked && unmarked.notable && unmarked.direction === "down") {
      return "визиты стали отмечать чаще — возможно, неявки были и раньше, но не попадали в счёт";
    }
    return null;
  }

  if (key === "unmarked" && d.direction === "up") {
    // Это наблюдение вообще не про пациентов, и сказать об этом обязательно.
    return "это не про пациентов: столько прошедших приёмов осталось без отметки о посещении";
  }

  if (key === "agentClosed" && d.direction === "down") {
    const gaps = other("escalations");
    if (gaps && gaps.notable && gaps.direction === "up") {
      return "человека звали чаще обычного — возможно, спрашивали то, чего нет в справочнике";
    }
    return null;
  }

  return null;
}

/**
 * Как описать отличие словами.
 *
 * «Обычно» — это медиана восьми недель, и она называется прямо: без неё число
 * повисает в воздухе, а «на 30% ниже» непонятно относительно чего.
 */
function describe(s: MetricSeries, d: Deviation): string {
  const now = formatValue(s.current, s.unit);
  const usual = formatValue(d.median, s.unit);
  const word = d.direction === "up" ? "выше" : "ниже";
  return `${now} — ${word} обычного (обычно ${usual})`;
}

export function buildDigest(input: DigestInput): Digest {
  const { series, appointments, appointmentsHistory } = input;

  const hasBaseline = series.some((s) => s.history.length >= 8);

  /**
   * Пустая неделя разбору не подлежит.
   *
   * На трёх приёмах любая доля — шум с видом наблюдения: одна неявка это
   * «33% неявок». Говорим прямо, что неделя была тихой, и не выдаём разброс
   * маленьких чисел за события (6.5).
   */
  if (tooQuiet(appointments, appointmentsHistory)) {
    return {
      observations: [],
      note:
        `На неделе прошло приёмов: ${appointments}. Это заметно меньше обычного, ` +
        "поэтому разбирать доли и сравнения не с чем — на таких числах они показывают разброс, а не изменения.",
      hasBaseline,
    };
  }

  if (!hasBaseline) {
    /**
     * Первые восемь недель. Сравнивать не с чем, поэтому показываем абсолютные
     * значения и говорим, почему нет сравнения. Подставлять сюда сравнение с
     * тремя имеющимися неделями нельзя: это была бы норма, придуманная нами.
     */
    return {
      observations: series.slice(0, MAX_OBSERVATIONS).map((s) => ({
        key: s.key,
        title: s.title,
        text: formatValue(s.current, s.unit),
        hypothesis: null,
        note: s.note ?? null,
        href: s.href,
        score: 0,
        direction: "up" as DeviationDirection,
        worse: false,
      })),
      note:
        "Сравнивать пока не с чем: чтобы отличить изменение от обычного колебания, нужно " +
        "восемь полных недель наблюдений. Ниже — просто значения этой недели.",
      hasBaseline: false,
    };
  }

  const deviations = new Map<string, Deviation>();
  for (const s of series) {
    deviations.set(s.key, deviationOf(s.history, s.current, s.minAbsolute));
  }

  const observations: Observation[] = series
    .map((s) => ({ s, d: deviations.get(s.key)! }))
    .filter(({ d }) => d.notable)
    .sort((a, b) => b.d.score - a.d.score)
    .slice(0, MAX_OBSERVATIONS)
    .map(({ s, d }) => ({
      key: s.key,
      title: s.title,
      text: describe(s, d),
      hypothesis: hypothesisFor(s.key, d, deviations),
      note: s.note ?? null,
      href: s.href,
      score: d.score,
      direction: d.direction,
      worse: s.worseWhen !== null && s.worseWhen === d.direction,
    }));

  return {
    observations,
    note:
      observations.length === 0
        ? "Ничего заметного: все показатели недели в пределах обычного для клиники разброса."
        : null,
    hasBaseline: true,
  };
}
