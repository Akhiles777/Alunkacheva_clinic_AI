/**
 * Сводка диалога для администратора: кто это и что было.
 *
 * Пациент написал сорок сообщений за три месяца; администратор открывает
 * переписку и первым делом листает её вверх, чтобы понять, о чём вообще речь.
 * Здесь то же самое в четыре строки.
 *
 * Считается НАШИМ кодом, а не пересказом модели. Причина не в экономии:
 * переписка с клиникой — врачебная тайна (§7), и отправлять её во внешнюю
 * модель ради красивого абзаца нельзя. Всё, что здесь есть, выведено из своих
 * данных теми же правилами, что и «Личное дело».
 */

export interface BriefMessage {
  direction: "IN" | "OUT";
  /** Ответ агента: он не считается ответом человека. */
  fromBot: boolean;
  text: string;
  at: Date;
}

export interface BriefFacts {
  messages: BriefMessage[];
  /** Состоявшиеся визиты и когда был последний. */
  visits: number;
  lastVisitAt: Date | null;
  /** Ближайшая запись впереди. */
  nextVisitAt: Date | null;
  /** Идущий курс: пройдено из скольких. */
  course: { title: string; used: number; total: number } | null;
  /** Открытая эскалация — вопрос, который ждёт человека. */
  escalationReason: string | null;
}

export interface Brief {
  /** Строки сводки. Пусто — рассказывать нечего, и блок не показывается. */
  lines: string[];
  /** О чём спрашивал: темы, узнанные по словам. */
  topics: string[];
}

/** Меньше этого числа сообщений сводка не нужна: всё видно глазами. */
export const MIN_MESSAGES_FOR_BRIEF = 6;

const TOPICS: { key: string; label: string; words: string[] }[] = [
  { key: "price", label: "цена", words: ["сколько стоит", "цена", "стоимость", "прайс"] },
  { key: "booking", label: "запись", words: ["записать", "записаться", "запишите", "свободн", "окошк"] },
  { key: "move", label: "перенос", words: ["перенест", "перенос", "отмен"] },
  { key: "address", label: "адрес и часы", words: ["адрес", "как добраться", "во сколько", "работаете"] },
  { key: "medical", label: "здоровье", words: ["боль", "болит", "температур", "противопоказ", "беременн", "диагноз"] },
  { key: "child", label: "ребёнок", words: ["ребён", "ребен", "сын", "дочь", "малыш"] },
  { key: "course", label: "курс", words: ["курс", "абонемент", "сеанс"] },
];

const DAY = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  timeZone: "Europe/Moscow",
});

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/**
 * О чём человек спрашивал — по его СОБСТВЕННЫМ словам.
 *
 * Наши ответы в разбор не идут: иначе тема «цена» появлялась бы от того, что
 * клиника прислала прайс, а не от того, что пациент про него спрашивал.
 */
export function topicsOf(messages: BriefMessage[]): string[] {
  const own = messages
    .filter((m) => m.direction === "IN")
    .map((m) => m.text.toLowerCase())
    .join(" \n ");
  return TOPICS.filter((t) => t.words.some((w) => own.includes(w))).map((t) => t.label);
}

export function briefOf(facts: BriefFacts, now: Date = new Date()): Brief {
  const { messages } = facts;
  if (messages.length < MIN_MESSAGES_FOR_BRIEF) return { lines: [], topics: [] };

  const lines: string[] = [];
  const ordered = [...messages].sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const fromPatient = ordered.filter((m) => m.direction === "IN").length;

  lines.push(
    `${messages.length} ${plural(messages.length, "сообщение", "сообщения", "сообщений")} с ${DAY.format(
      first.at,
    )}, из них ${fromPatient} от пациента.`,
  );

  /** Что человек знает о клинике на деле — визиты, а не переписка. */
  if (facts.visits === 0) {
    lines.push("Визитов ещё не было — знакомство идёт по переписке.");
  } else {
    lines.push(
      `Визитов ${facts.visits}${
        facts.lastVisitAt ? `, последний ${DAY.format(facts.lastVisitAt)}` : ""
      }.`,
    );
  }

  if (facts.course) {
    lines.push(`Идёт курс «${facts.course.title}»: ${facts.course.used} из ${facts.course.total}.`);
  }

  if (facts.nextVisitAt) {
    lines.push(`Впереди запись ${DAY.format(facts.nextVisitAt)}.`);
  }

  /**
   * Чем кончился разговор. Ответ агента ответом человека не считается: если
   * последним говорил бот, вопрос всё ещё может быть открыт.
   */
  if (last.direction === "IN") {
    const waited = Math.round((now.getTime() - last.at.getTime()) / 60_000);
    lines.push(
      waited < 60
        ? `Последним написал пациент — ${waited} мин назад, ответа ещё не было.`
        : `Последним написал пациент, ответа не было.`,
    );
  } else if (last.fromBot) {
    lines.push("Последним отвечал ассистент — человек в разговор не вступал.");
  } else {
    lines.push("Последним отвечал сотрудник.");
  }

  if (facts.escalationReason) {
    lines.push(`Открыт вопрос к человеку: ${facts.escalationReason}.`);
  }

  return { lines, topics: topicsOf(messages) };
}
