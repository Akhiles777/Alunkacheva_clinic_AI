import { rangeKeyOf, type PeriodKey } from "@/lib/metrics/types";

/**
 * Какой период спрашивает владелец.
 *
 * Живой разговор: «сделай срез по загрузке кабинетов за 1–18 сентября» — и
 * честный отказ в ответ. Отказ был правильным по правилам: своя арифметика
 * модели запрещена (§8, она уже ошиблась на сто тысяч), а готового среза за
 * этот отрезок в сводке не было — там месяцы и недели.
 *
 * Значит вопрос не в модели, а в данных: нужного среза ей не давали. Здесь мы
 * узнаём отрезок в самом вопросе, а считает его потом наш обычный код —
 * теми же функциями, что рисуют отчёты. Не угадали период — ничего не
 * добавляем, и аналитик работает как раньше.
 */

const MONTHS: [RegExp, number][] = [
  [/январ/i, 0], [/феврал/i, 1], [/март/i, 2], [/апрел/i, 3],
  [/ма[йя]\b|мае\b/i, 4], [/июн/i, 5], [/июл/i, 6], [/август/i, 7],
  [/сентябр/i, 8], [/октябр/i, 9], [/ноябр/i, 10], [/декабр/i, 11],
];

function monthOf(text: string): number | null {
  for (const [re, index] of MONTHS) if (re.test(text)) return index;
  return null;
}

const p2 = (n: number) => String(n).padStart(2, "0");
const monthKey = (year: number, month: number) => `${year}-${p2(month + 1)}`;

/**
 * Год у названного месяца.
 *
 * «За август» в сентябре — это август ЭТОГО года, а «за декабрь» в январе —
 * декабрь прошлого: назад смотрят чаще, чем вперёд, и месяц из будущего почти
 * всегда означает прошлый год.
 */
function yearFor(month: number, now: Date): number {
  const year = now.getFullYear();
  return month > now.getMonth() ? year - 1 : year;
}

/** Дата «1 сентября» / «01.09» / «1.09.2026» внутри вопроса. */
interface Day {
  day: number;
  month: number | null;
  year: number | null;
}

const DOT = /(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?/g;

function dotDates(text: string): Day[] {
  const out: Day[] = [];
  for (const m of text.matchAll(DOT)) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    if (day < 1 || day > 31 || month < 0 || month > 11) continue;
    const raw = m[3] ? Number(m[3]) : null;
    out.push({ day, month, year: raw === null ? null : raw < 100 ? 2000 + raw : raw });
  }
  return out;
}

const DASH = "[–—−-]";

export function periodFromQuestion(question: string, now: Date = new Date()): PeriodKey | null {
  const q = question.toLowerCase().replace(/ /g, " ");

  // «за этот месяц», «в текущем месяце»
  if (/(?:эт(?:от|ом)|текущ[а-яё]+)\s+месяц/.test(q)) return monthKey(now.getFullYear(), now.getMonth());
  if (/прошл[а-яё]+\s+месяц|предыдущ[а-яё]+\s+месяц/.test(q)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return monthKey(d.getFullYear(), d.getMonth());
  }

  /**
   * «1–18 сентября», «с 1 по 18 сентября», «за 1 - 18 сентября».
   *
   * Месяц называется один раз и относится к обеим датам — так и говорят.
   */
  const named = q.match(
    new RegExp(`(?:с\\s+)?(\\d{1,2})\\s*(?:${DASH}|по)\\s*(\\d{1,2})\\s*([а-яё]+)`, "i"),
  );
  if (named) {
    const month = monthOf(named[3]);
    if (month !== null) {
      const year = yearFor(month, now);
      const a = Number(named[1]);
      const b = Number(named[2]);
      if (a >= 1 && b >= a && b <= 31) {
        return rangeKeyOf(
          new Date(Date.UTC(year, month, a)),
          new Date(Date.UTC(year, month, b)),
        );
      }
    }
  }

  /** «с 1 сентября по 18 сентября» — месяц у каждой даты свой. */
  const twoNamed = [...q.matchAll(/(\d{1,2})\s+([а-яё]{3,})/gi)]
    .map((m) => ({ day: Number(m[1]), month: monthOf(m[2]) }))
    .filter((d) => d.month !== null && d.day >= 1 && d.day <= 31);
  if (twoNamed.length >= 2) {
    const [a, b] = twoNamed;
    const yearA = yearFor(a.month!, now);
    const yearB = yearFor(b.month!, now);
    const from = new Date(Date.UTC(yearA, a.month!, a.day));
    const to = new Date(Date.UTC(yearB, b.month!, b.day));
    if (to >= from) return rangeKeyOf(from, to);
  }

  /** «01.09–18.09», «1.09.2026 по 18.09.2026». */
  const dots = dotDates(q);
  if (dots.length >= 2) {
    const [a, b] = dots;
    const from = new Date(Date.UTC(a.year ?? yearFor(a.month!, now), a.month!, a.day));
    const to = new Date(Date.UTC(b.year ?? yearFor(b.month!, now), b.month!, b.day));
    if (to >= from) return rangeKeyOf(from, to);
  }

  /**
   * «с 1 сентября» — от названного дня до сегодня.
   *
   * Верхняя граница — сегодняшний день: владелец спрашивает «как идём с начала
   * месяца», а не «включая будущие записи».
   */
  const since = q.match(new RegExp(`с\\s+(\\d{1,2})\\s+([а-яё]{3,})`, "i"));
  if (since) {
    const month = monthOf(since[2]);
    if (month !== null) {
      const year = yearFor(month, now);
      const from = new Date(Date.UTC(year, month, Number(since[1])));
      const to = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
      if (to >= from) return rangeKeyOf(from, to);
    }
  }

  /**
   * Просто месяц: «за август», «в сентябре».
   *
   * Проверяется последним: если рядом были числа, отрезок точнее месяца.
   */
  // Без `\b`: в JavaScript он опирается на латинский \w и рядом с кириллицей
  // не находится вовсе — «в декабре?» не совпадало (CLAUDE.md, §6).
  if (/за\s+[а-яё]+|в\s+[а-яё]+е(?![а-яё])|месяц/.test(q)) {
    const month = monthOf(q);
    if (month !== null) return monthKey(yearFor(month, now), month);
  }

  return null;
}
