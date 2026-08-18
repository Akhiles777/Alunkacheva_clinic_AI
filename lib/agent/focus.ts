/**
 * О чём именно спросили.
 *
 * Живой диалог: «Хочу записать ребенка к Ирине Алункачевой на остеопатию,
 * сколько стоит?» — в ответ пришёл весь раздел справочника: два остеопата,
 * взрослые и детские цены, четыре суммы. Человек спросил одну цену, получил
 * четыре и справедливо переспросил. На переспрос «Я же сказал лишь Ирина
 * Алункачева» ассистент рассказал про программу «Лотос» — в её описании тоже
 * есть имя Ирины, и короткая реплика совпала именно с ней.
 *
 * Два разных сбоя, и оба лечатся не уговорами модели, а подготовкой запроса:
 *
 *   1. Короткое уточнение ищет справку по себе одному, теряя вопрос, к
 *      которому относится. Ищем по уточнению ВМЕСТЕ с предыдущим вопросом.
 *   2. Модель видит запись справочника целиком и печатает её целиком. Значит
 *      надо прямо сказать, что из неё нужно: для кого приём и какого врача
 *      назвал пациент.
 */

/** Слова, по которым видно, что реплика уточняет предыдущий вопрос. */
const CORRECTION =
  /(?<!\p{L})(я же|же сказал|сказал[аи]? же|именно|только|лишь|нет,|не то|я про|речь о|спрашива)/iu;

/** Короткая реплика без своего предмета: сама по себе искать по ней нечего. */
const SHORT_ENOUGH = 60;

/**
 * Текст, по которому ищем услуги и справку.
 *
 * Уточнение без предыдущего вопроса — это половина фразы. «Я же сказал лишь
 * Ирина Алункачева» само по себе означает только имя, и справочник честно
 * находит по нему всё, где это имя встречается.
 */
export function searchText(current: string, previousPatientMessages: string[]): string {
  const now = current.trim();
  if (now.length === 0) return now;

  const looksLikeCorrection = CORRECTION.test(now) || now.length <= SHORT_ENOUGH;
  if (!looksLikeCorrection) return now;

  // Последний содержательный вопрос пациента: по нему и был разговор.
  const previous = [...previousPatientMessages]
    .reverse()
    .find((m) => m.trim().length > SHORT_ENOUGH || /\?/.test(m));
  return previous ? `${previous.trim()} ${now}` : now;
}

export interface Focus {
  /** Для кого приём, если пациент это сказал. */
  whom: "child" | "adult" | null;
  /** Кого из специалистов пациент назвал — его словами. */
  staffMentioned: string | null;
}

/**
 * Имя специалиста, названное пациентом, — его же словами.
 *
 * Разрешать имя в карточку справочника нельзя: в клинике две Ирины, и по
 * одному имени выбор был бы угадыванием. А пациент к тому же зовёт врача не
 * так, как он записан: «Ирина Алункачева» при записи «Ирина Алилгаджиевна».
 *
 * Поэтому возвращаем ровно то, что человек написал. Этого достаточно: модель
 * видит и справочник, и список принимающих, и сама сопоставит — от неё нужно
 * лишь не отвечать про других врачей.
 *
 * Признак «это имя врача» — совпадение основы с именем или фамилией из
 * справочника клиники. Не список слов в коде: врачей нанимают и увольняют.
 */
function mentionedStaff(question: string, staffNames: string[]): string | null {
  const norm = (v: string) => v.toLowerCase().replace(/ё/g, "е");
  const stems = new Set<string>();
  for (const name of staffNames) {
    for (const part of norm(name).split(/\s+/)) {
      if (part.length >= 5) stems.add(part.slice(0, 4));
    }
  }
  if (stems.size === 0) return null;

  // Разбираем исходный текст, чтобы вернуть имя так, как его написал человек.
  const tokens = question.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const bare = tokens[i].replace(/[^\p{L}]/gu, "");
    if (bare.length < 5) continue;
    if (!stems.has(norm(bare).slice(0, 4))) continue;

    /**
     * Забираем и следующее слово, если оно с заглавной: «Ирине Алункачевой».
     * Фамилия — как раз то, что отличает одну Ирину от другой, и терять её
     * нельзя.
     */
    const next = tokens[i + 1]?.replace(/[^\p{L}]/gu, "") ?? "";
    const withSurname = next.length >= 4 && next[0] === next[0].toUpperCase() && /\p{Lu}/u.test(next[0]);
    return withSurname ? `${bare} ${next}` : bare;
  }
  return null;
}

export interface Focus {
  /** Для кого приём, если пациент это сказал. */
  whom: "child" | "adult" | null;
  /** Кого из специалистов пациент назвал — его словами. */
  staffMentioned: string | null;
}

export function focusOf(
  question: string,
  whom: "child" | "adult" | "unknown",
  staffNames: string[],
): Focus {
  return {
    whom: whom === "unknown" ? null : whom,
    staffMentioned: mentionedStaff(question, staffNames),
  };
}

/**
 * Строка для промпта: что нужно ответить и чего отвечать не нужно.
 *
 * Пустая, если из вопроса ничего не сузилось — тогда модель работает как
 * раньше и лишних ограничений не получает.
 */
export function focusLine(focus: Focus): string {
  const parts: string[] = [];
  if (focus.whom === "child") parts.push("приём ДЕТСКИЙ");
  if (focus.whom === "adult") parts.push("приём ВЗРОСЛЫЙ");
  if (focus.staffMentioned) parts.push(`врач — ${focus.staffMentioned}`);
  if (parts.length === 0) return "";

  return (
    `СПРОСИЛИ КОНКРЕТНО: ${parts.join(", ")}. ` +
    "Ответь только про это. Если в справке описаны несколько врачей или и детский, " +
    "и взрослый приём — назови подходящий и не перечисляй остальные: " +
    "человек спросил одну цену, а не прайс."
  );
}
