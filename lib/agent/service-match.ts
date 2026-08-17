/**
 * Какие услуги подходят под вопрос пациента.
 *
 * Модели давался весь прайс — шесть десятков строк, среди которых «Остеопатия
 * — дети, приём Ирины» за 4900 и «Взрослый приём — остеопатия» за 8000. На
 * прямой вопрос «хотела ребёнка записать» она назвала взрослую цену. Это не
 * та ошибка, которую чинят уговорами в промпте: выбирать из шести десятков
 * похожих строк — работа для кода, а не для модели.
 *
 * Здесь мы сами отбираем подходящие услуги и отдаём их отдельным списком с
 * пометкой «цену бери отсюда». Модель формулирует ответ, но цену не выбирает.
 */

export interface ServiceLike {
  title: string;
  price: number;
  durationMin: number;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Для кого приём — по словам пациента. */
export type Whom = "child" | "adult" | "unknown";

const CHILD_WORDS =
  /(?<!\p{L})(ребен|ребён|детск|дет[еяи]|сын|доч|мальчик|девочк|малыш|подрост|годик|месяц\p{L}*\s+ребен)/iu;
/**
 * Основы пишем без границы справа: «взросл» продолжается «ый», и запрет буквы
 * после основы не давал совпасть ни разу. Целые слова — с границей, иначе
 * «мне» найдётся внутри «мнение».
 */
const ADULT_WORDS =
  /(?<!\p{L})(?:взросл\p{L}*|муж\p{L}*|жен[еуы]|себя|для меня|(?:мне|маме|папе)(?!\p{L}))/iu;

export function whomFor(text: string): Whom {
  const t = norm(text);
  const child = CHILD_WORDS.test(t);
  const adult = ADULT_WORDS.test(t);
  // Сказали и то и другое («записать ребёнка и себя») — выбирать нельзя.
  if (child && adult) return "unknown";
  if (child) return "child";
  if (adult) return "adult";
  return "unknown";
}

/** Услуга детская по названию. */
function isChildService(title: string): boolean {
  return /(?<!\p{L})(дет[си]|ребен|ребён|подрост)/iu.test(norm(title));
}

/** Услуга для беременных — отдельная, ни к детям, ни к обычным взрослым. */
function isPregnancyService(title: string): boolean {
  return /беремен/i.test(norm(title));
}

/**
 * Значимые слова вопроса: по ним ищем услугу.
 *
 * Имя врача считается значимым: у клиники приём «Ирины» и приём «Разият» —
 * разные услуги с разными ценами.
 */
function words(text: string): string[] {
  return norm(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length >= 4);
}

/** Насколько название услуги отвечает вопросу: доля совпавших основ. */
function relevance(title: string, question: string): number {
  const q = words(question);
  const t = words(title);
  if (q.length === 0 || t.length === 0) return 0;

  /**
   * Сравниваем по четырём первым буквам.
   *
   * На пяти «Ирине» и «Ирины» не совпадали, и вопрос «хотела ребёнка записать
   * к Ирине Алункачевой» не находил ни одной услуги: пациентка назвала врача,
   * а не услугу, и подбор возвращал пустоту. Четырёх букв хватает на падежи и
   * мало для случайных совпадений: «приём» и «привет» расходятся уже здесь.
   */
  let hits = 0;
  for (const w of q) {
    const stem = w.slice(0, 4);
    if (t.some((x) => x.startsWith(stem) || w.startsWith(x.slice(0, 4)))) hits += 1;
  }
  return hits / q.length;
}

/**
 * Услуги, подходящие под вопрос. Пустой список означает «ничего не нашли» —
 * тогда модель работает по общему прайсу, как раньше.
 */
export function matchServices<T extends ServiceLike>(
  question: string,
  services: T[],
  limit = 6,
): T[] {
  const whom = whomFor(question);

  const scored = services
    .map((s) => ({ s, score: relevance(s.title, question) }))
    .filter((x) => x.score > 0);
  if (scored.length === 0) return [];

  /**
   * Отсев по возрасту — главное. Спросили про ребёнка: взрослые услуги в
   * список не идут вовсе, иначе модель снова назовёт цену взрослого приёма.
   */
  const fits = scored.filter(({ s }) => {
    if (isPregnancyService(s.title)) return whom === "unknown" || /беремен/i.test(norm(question));
    if (whom === "child") return isChildService(s.title);
    if (whom === "adult") return !isChildService(s.title);
    return true;
  });

  const use = fits.length > 0 ? fits : scored;
  return use
    .sort((a, b) => b.score - a.score || a.s.price - b.s.price)
    .slice(0, limit)
    .map((x) => x.s);
}
