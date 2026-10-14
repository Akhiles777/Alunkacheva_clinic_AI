/**
 * Память разговора ассистента администратора — в пределах чата.
 *
 * Администратор говорит как с коллегой: «найди Диану» → «вторая» → «а ей
 * напиши, что перенос на понедельник» → «нет, другой». Без памяти каждый
 * вопрос начинался с нуля, и «ей» не значило ничего.
 *
 * Главное правило то же, что везде: среди НЕСКОЛЬКИХ подходящих ассистент не
 * выбирает сам. Местоимение указывает на того, о ком речь, только если речь
 * шла ровно об одном человеке; из списка выбирает администратор — номером или
 * фамилией. Память хранит только идентификаторы, без имён и телефонов.
 */

export interface MemoryCandidate {
  id: string;
  name: string;
}

export interface AdminMemory {
  /** О ком сейчас речь — ровно один пациент, или никто. */
  focus: string | null;
  /** Последний показанный список «уточните, кого» — по порядку, как на экране. */
  candidates: MemoryCandidate[];
  /** Последнее подготовленное письмо одному: «ей тоже» повторяет его текст. */
  lastText: string | null;
}

export const EMPTY_MEMORY: AdminMemory = { focus: null, candidates: [], lastText: null };

export type RefResolution =
  | { kind: "none" }
  | { kind: "patient"; patientId: string; how: "pronoun" | "ordinal" | "name" | "other" }
  /** Нужен выбор администратора: показать список и ничего не делать. */
  | { kind: "choose"; candidates: MemoryCandidate[] };

const PRONOUN =
  /(?<!\p{L})(?:ей|ему|ней|нему|неё|нее|него|её|ее|его|она|он|этой|этому|этого|эту|этот|эта|ему\s+же|ей\s+же)(?!\p{L})/iu;
const OTHER = /(?<!\p{L})(?:друг(?:ой|ому|ую|ая|ого|ие|им)|не\s+(?:та|тот|той|тому|ей|ему|она|он|её|ее|его))(?!\p{L})/iu;
const ORDINALS: [RegExp, number][] = [
  [/^перв/iu, 0],
  [/^втор/iu, 1],
  [/^трет/iu, 2],
  [/^четв[её]рт/iu, 3],
  [/^пят/iu, 4],
  [/^шест/iu, 5],
  [/^седьм/iu, 6],
  [/^восьм/iu, 7],
  [/^девят/iu, 8],
  [/^десят/iu, 9],
];

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** «вторая», «№ 2», «2», «номер два» — в начале реплики. */
export function ordinalOf(question: string): number | null {
  const q = norm(question.trim()).replace(/^(?:а|нет|да|ну)[,\s]+/u, "");
  const digit = /^(?:№\s*|номер\s+)?(\d{1,2})(?!\d)/u.exec(q);
  if (digit) return Number(digit[1]) - 1;
  const first = q.split(/[\s,.!?:;]+/u)[0] ?? "";
  for (const [re, i] of ORDINALS) if (re.test(first)) return i;
  return null;
}

/** Слова имени, по которым можно узнать человека: «Алиева» узнаёт «Алиева Диана». */
function nameWords(name: string): string[] {
  return norm(name)
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 3);
}

/** Слова с заглавной буквы — имена; в реплике из нескольких слов первое не в счёт. */
function capitalWords(question: string): string[] {
  const words = question.trim().split(/[^\p{L}]+/u).filter(Boolean);
  const pool = words.length > 1 ? words.slice(1) : words;
  return pool.filter((w) => /^\p{Lu}/u.test(w) && w.length >= 3).map(norm);
}

function sameStem(a: string, b: string): boolean {
  const n = Math.max(4, Math.min(a.length, b.length) - 2);
  return a.slice(0, n) === b.slice(0, n);
}

/**
 * На кого указывает реплика — по памяти разговора. Имя пациента в самой
 * реплике разбирает основной поиск; здесь — только то, что без памяти понять
 * нельзя.
 */
export function resolveRef(question: string, memory: AdminMemory): RefResolution {
  const list = memory.candidates;

  // Выбранный только что человек и местоимение — это он, а не слово из списка.
  if (memory.focus && PRONOUN.test(question) && !OTHER.test(question)) {
    return { kind: "patient", patientId: memory.focus, how: "pronoun" };
  }

  if (list.length > 0) {
    const i = ordinalOf(question);
    if (i !== null) {
      return i >= 0 && i < list.length ? { kind: "patient", patientId: list[i].id, how: "ordinal" } : { kind: "choose", candidates: list };
    }
    /**
     * Фамилия или имя из показанного списка — если подходит ровно один. Только
     * слова с заглавной: «напиши» по первым буквам совпадало с именем
     * «Написат», и письмо готовилось чужому человеку.
     */
    const said = capitalWords(question);
    const hits = list.filter((c) => nameWords(c.name).some((w) => said.some((s) => sameStem(s, w))));
    const distinct = hits.filter((c, j, all) => all.findIndex((x) => x.id === c.id) === j);
    if (distinct.length === 1 && distinct.length < list.length) {
      return { kind: "patient", patientId: distinct[0].id, how: "name" };
    }
  }

  if (OTHER.test(question)) {
    const rest = list.filter((c) => c.id !== memory.focus);
    if (rest.length === 1 && memory.focus) return { kind: "patient", patientId: rest[0].id, how: "other" };
    if (rest.length > 0) return { kind: "choose", candidates: rest };
    return { kind: "none" };
  }

  if (PRONOUN.test(question)) {
    if (memory.focus) return { kind: "patient", patientId: memory.focus, how: "pronoun" };
    if (list.length > 1) return { kind: "choose", candidates: list };
  }
  return { kind: "none" };
}

/** «Ей тоже», «и Патимат то же самое» — повторить последнее письмо другому адресату. */
export function asksSameAgain(question: string): boolean {
  return /(?<!\p{L})(?:тоже|также|то\s+же\s+самое|то\s+же|так\s+же)(?!\p{L})/iu.test(question);
}

/** Память после ответа: что ответ сказал о себе, поверх прежнего. */
export function nextMemory(prev: AdminMemory, update: Partial<AdminMemory> | undefined): AdminMemory {
  if (!update) return prev;
  return {
    focus: update.focus !== undefined ? update.focus : prev.focus,
    candidates: update.candidates !== undefined ? update.candidates : prev.candidates,
    lastText: update.lastText !== undefined ? update.lastText : prev.lastText,
  };
}

/** Прочитать память из сохранённого сообщения — только то, что похоже на неё. */
export function memoryFrom(raw: unknown): AdminMemory {
  if (!raw || typeof raw !== "object") return EMPTY_MEMORY;
  const m = raw as Record<string, unknown>;
  const candidates = Array.isArray(m.candidates)
    ? (m.candidates as unknown[])
        .filter((c): c is MemoryCandidate => Boolean(c && typeof (c as MemoryCandidate).id === "string"))
        .map((c) => ({ id: c.id, name: typeof c.name === "string" ? c.name : "" }))
        .slice(0, 20)
    : [];
  return {
    focus: typeof m.focus === "string" ? m.focus : null,
    candidates,
    lastText: typeof m.lastText === "string" ? m.lastText.slice(0, 2000) : null,
  };
}
