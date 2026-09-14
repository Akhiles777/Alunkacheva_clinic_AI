/**
 * Ответ ассистента администратора на вопрос про пациента.
 *
 * «Сколько он должен?», «когда последний раз был у остеопата?», «покупал ли
 * курс?» — администратор спрашивает, не уходя из переписки в карточку.
 *
 * Отвечает КОД, а не модель, и это решение, а не экономия:
 *   · в вопросе и ответе — визиты, деньги и услуги конкретного человека, то
 *     есть персональные и медицинские данные; во внешнюю модель они не уходят
 *     (§7, §6.5);
 *   · число, сочинённое моделью, выглядит посчитанным и оказывается неверным —
 *     аналитик владельца уже однажды так ошибся на сотню тысяч (§8).
 *
 * Считается из тех же данных, что рисуют карточку, и теми же правилами
 * (`glanceOf`): ответ ассистента не может разойтись с тем, что написано на
 * экране строкой ниже. На вопрос, для которого расчёта нет, — честное «не
 * знаю» и список того, что умеем, а не правдоподобная цифра.
 */
import { glanceOf, type GlanceCourse, type GlanceVisit } from "./patient-glance";

export interface AnswerVisit extends GlanceVisit {
  /** Подпись визита для человека — его состав (`visitTitle`). */
  title: string;
}

export interface AnswerFacts {
  visits: AnswerVisit[];
  courses: GlanceCourse[];
}

export interface PatientAnswer {
  text: string;
  /** false — вопрос не распознан; экран показывает подсказку, что спросить. */
  known: boolean;
}

/** Готовые вопросы под полем: набирать их руками незачем. */
export const SUGGESTED_QUESTIONS = [
  "Должен ли что-то?",
  "Когда был последний раз?",
  "Ближайшая запись",
  "Покупал ли курс?",
  "Сколько неявок?",
  "Сколько раз приходил и на какую сумму?",
];

const DAY = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Moscow",
});
const DAY_TIME = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});
const MONEY = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const rub = (n: number) => `${MONEY.format(Math.round(n))} ₽`;

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

const times = (n: number) => `${n} ${plural(n, "раз", "раза", "раз")}`;

/**
 * Слова вопроса, которые не называют ни услугу, ни врача.
 *
 * Остальные — фильтр: «последний раз у остеопата» ищет визиты, где в услуге
 * или в имени врача есть «остеопат». Без этого на такой вопрос отвечали бы
 * последним визитом вообще — к другому специалисту.
 */
const FILTER_NOISE = new Set(
  (
    "когда последний последняя последнее последнего раз был была были ходил ходила ходили " +
    "приходил приходила приходили к у на в по с до и а он она они его её ее их этот эта пациент " +
    "пациентка визит визиты прием приём приема приёма давно уже ли ещё еще раз был его что как"
  ).split(" "),
);

function filterStems(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^а-яa-z0-9-]+/)
    // От трёх букв: «БОС», «НАК», «ЛФК» — названия услуг клиники.
    .filter((w) => w.length >= 3 && !FILTER_NOISE.has(w))
    .map((w) => (w.length <= 4 ? w : w.slice(0, Math.min(6, w.length - 2))));
}

const matches = (v: AnswerVisit, stems: string[]) => {
  const hay = `${v.title} ${v.service} ${v.doctor}`.toLowerCase().replace(/ё/g, "е");
  return stems.some((s) => hay.includes(s));
};

const when = (v: AnswerVisit) => (v.at ? DAY.format(new Date(v.at)) : "дата неизвестна");
const describe = (v: AnswerVisit) => `${when(v)} — ${v.title}${v.doctor ? `, ${v.doctor}` : ""}`;

type Rule = { re: RegExp; answer: (q: string, f: AnswerFacts, now: Date) => string };

const RULES: Rule[] = [
  {
    // Долг — первым: «не оплатил» содержит и «оплат», и отрицание.
    re: /долж|долг|задолж|оплат|недоплат|не\s+заплат/,
    answer: (_q, f, now) => {
      const real = f.visits.filter((v) => v.kind !== "purchase");
      /**
       * Та же осторожность, что у строки в карточке: если оплату у человека не
       * отмечают вовсе, «должен» — это требование денег, которые могли отдать.
       */
      if (!real.some((v) => v.paidEarlier === true)) {
        return "Сказать нельзя: оплату визитов этого пациента в YCLIENTS не отмечают, и «не отмечено» тут не значит «не платил».";
      }
      const g = glanceOf(f.visits, f.courses, now);
      return g.owes
        ? `Не отмечено оплаченным: ${rub(g.owes.amount)} по ${g.owes.visits} ${plural(g.owes.visits, "визиту", "визитам", "визитам")}. Это повод спросить, а не счёт — своего финучёта у нас нет.`
        : "Неоплаченных визитов не видно: все состоявшиеся с суммой отмечены оплаченными.";
    },
  },
  {
    re: /ближайш|следующ|когда\s+(?:\p{L}+\s+)?запис|записан|придет|приедет|впереди/u,
    answer: (_q, f, now) => {
      const g = glanceOf(f.visits, f.courses, now);
      if (!g.next) return "Записей впереди нет.";
      const later = f.visits.filter(
        (v) => v.kind !== "purchase" && v.status === "planned" && v.at && new Date(v.at) > now,
      ).length;
      return (
        `Ближайшая запись — ${DAY_TIME.format(new Date(g.next.at))}: ${g.next.service}` +
        `${g.next.doctor ? `, ${g.next.doctor}` : ""}.` +
        (later > 1 ? ` Всего впереди ${later} ${plural(later, "запись", "записи", "записей")}.` : "")
      );
    },
  },
  {
    re: /неяв|не\s+(?:приход|приш)|пропуск|пропуска/,
    answer: (_q, f) => {
      const done = f.visits.filter(
        (v) => v.kind !== "purchase" && (v.status === "arrived" || v.status === "no_show"),
      );
      const missed = done.filter((v) => v.status === "no_show").length;
      if (done.length === 0) return "Прошедших визитов ещё не было — считать не из чего.";
      return missed === 0
        ? `Неявок нет: пришёл все ${done.length} ${plural(done.length, "раз", "раза", "раз")}.`
        : `Не пришёл ${times(missed)} из ${done.length}.`;
    },
  },
  {
    re: /отмен/,
    answer: (_q, f) => {
      const n = f.visits.filter((v) => v.kind !== "purchase" && v.status === "cancelled").length;
      return n === 0 ? "Отменённых записей нет." : `Отменённых записей: ${n}.`;
    },
  },
  {
    re: /курс|абонемент|сеанс/,
    answer: (_q, f) => {
      if (f.courses.length === 0) return "Курсов не покупал.";
      const state = { active: "идёт", stalled: "выпал из графика", done: "пройден" } as const;
      return f.courses
        .map(
          (c) =>
            `${c.title}: ${c.used}/${c.total}` +
            ((c.booked ?? 0) > 0 ? `, записан ещё на ${c.booked}` : "") +
            ` — ${state[c.status]}`,
        )
        .join("; ")
        .concat(".");
    },
  },
  {
    re: /впервые|первый\s+(?:раз|визит)|перв\p{L}*\s+приём|перв\p{L}*\s+прием|с\s+какого\s+времени/u,
    answer: (_q, f) => {
      const first = f.visits
        .filter((v) => v.kind !== "purchase" && v.status === "arrived" && v.at)
        .sort((a, b) => new Date(a.at!).getTime() - new Date(b.at!).getTime())[0];
      return first ? `Первый состоявшийся визит — ${describe(first)}.` : "Состоявшихся визитов ещё не было.";
    },
  },
  {
    re: /сколько\s+(?:раз|визит|при[её]м|потрат|заплат|принес|принёс|денег)|на\s+какую\s+сумму|выручк/,
    answer: (_q, f) => {
      const arrived = f.visits.filter((v) => v.kind !== "purchase" && v.status === "arrived");
      const purchases = f.visits.filter((v) => v.kind === "purchase");
      const money =
        arrived.reduce((s, v) => s + v.amount, 0) + purchases.reduce((s, v) => s + v.amount, 0);
      if (arrived.length === 0 && purchases.length === 0) return "Состоявшихся визитов и покупок нет.";
      return (
        `Пришёл ${times(arrived.length)}` +
        (purchases.length > 0
          ? `, купил ${purchases.length} ${plural(purchases.length, "курс", "курса", "курсов")}`
          : "") +
        `. По записям — ${rub(money)}` +
        (purchases.length > 0 ? " (сеансы курса в записи идут нулём, их деньги — в покупке курса)." : ".")
      );
    },
  },
  {
    re: /последн|когда\s+(?:\p{L}+\s+)?(?:был|была|приход|ходил)|давно\s+не/u,
    answer: (q, f) => {
      const arrived = f.visits
        .filter((v) => v.kind !== "purchase" && v.status === "arrived" && v.at)
        .sort((a, b) => new Date(b.at!).getTime() - new Date(a.at!).getTime());
      if (arrived.length === 0) return "Состоявшихся визитов ещё не было.";
      const stems = filterStems(q);
      if (stems.length > 0) {
        const hit = arrived.find((v) => matches(v, stems));
        if (hit) return `Последний раз — ${describe(hit)}.`;
        return `Визитов по такому запросу не нашёл. Последний визит вообще — ${describe(arrived[0])}.`;
      }
      return `Последний визит — ${describe(arrived[0])}.`;
    },
  },
  {
    re: /что\s+бер|как\p{L}*\s+услуг|к\s+кому|у\s+кого|какому\s+врач|какого\s+врач|к\s+какому/u,
    answer: (_q, f) => {
      const arrived = f.visits.filter((v) => v.kind !== "purchase" && v.status === "arrived");
      if (arrived.length === 0) return "Состоявшихся визитов ещё не было.";
      const top = (key: (v: AnswerVisit) => string) =>
        [...arrived.reduce((m, v) => m.set(key(v), (m.get(key(v)) ?? 0) + 1), new Map<string, number>())]
          .filter(([k]) => k)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, n]) => `${k} — ${n}`)
          .join("; ");
      const doctors = top((v) => v.doctor);
      return `Чаще всего: ${top((v) => v.title)}.` + (doctors ? ` Специалисты: ${doctors}.` : "");
    },
  },
];

export function answerAboutPatient(question: string, facts: AnswerFacts, now: Date = new Date()): PatientAnswer {
  const q = question.toLowerCase().replace(/ё/g, "е").trim();
  if (!q) return { text: "", known: false };
  const rule = RULES.find((r) => r.re.test(q));
  if (!rule) {
    return {
      known: false,
      text:
        "Не знаю: на такой вопрос у меня нет расчёта, а угадывать цифры я не буду. " +
        "Могу ответить про долг, последний и первый визит, ближайшую запись, курсы, неявки, отмены, " +
        "сколько раз приходил и на какую сумму, к кому ходит.",
    };
  }
  return { known: true, text: rule.answer(q, facts, now) };
}
