/**
 * Окошко из статуса WhatsApp — разбор текста и выбор даты.
 *
 * Свободные окошки администратор выкладывает статусом: «Окошко на завтра к
 * Ирине Алилгаджиевне ✅ 09:40 (детский)». Пациент отвечает на статус, и в
 * переписку приходит его ответ вместе с цитатой статуса. Агент на это
 * спрашивал «на какую услугу хотите?» — хотя врач, время и вид приёма написаны
 * в том, на что человек отвечал.
 *
 * Здесь только чистые правила: текст статуса → врач, время, день, вид приёма.
 * Базы и сети тут нет — их проверяют тесты, а решения о закреплении окошка
 * принимает lib/agent/slot-hold.ts.
 *
 * Главный принцип: не угадывать. Окошко не на тот день — это человек, пришедший
 * зря. Поэтому всё, что читается двояко (двое врачей в одном статусе, «к
 * Ирине» при двух Иринах, «на завтра» без времени публикации), отдаётся либо
 * на уточнение пациенту, либо администратору — но не решается догадкой.
 */

import { CLINIC_TZ, clinicDateKey, startOfClinicDay } from "@/lib/clinic-time";

export interface SlotStaff {
  id: string;
  name: string;
}

/** День из статуса. */
export type DaySpec =
  | { kind: "relative"; offset: 0 | 1 | 2 }
  | { kind: "weekday"; weekday: number }
  | { kind: "date"; day: number; month: number };

export interface StatusOffer<T extends SlotStaff> {
  /** Врач, названный однозначно. */
  staff: T | null;
  /** Врач назван, но кто именно — сказать нельзя (две Ирины, двое врачей). */
  staffAmbiguous: boolean;
  /** Начала окошек, минуты от полуночи клиники, по возрастанию. */
  times: number[];
  day: DaySpec | null;
  audience: "child" | "adult" | null;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/**
 * Слова, по которым видно, что статус предлагает свободное время.
 *
 * Без них цитатой может оказаться что угодно от клиники: напоминание о записи
 * («Вы записаны … на 8 сентября в 09:00») — это запись самого пациента, а не
 * свободное окошко, и «закрепить» её за ним было бы бессмыслицей.
 */
const OFFER_WORDS =
  /(?<!\p{L})(?:окош\p{L}*|окн[оаеу]|окон|свобод\p{L}*|освобод\p{L}*)(?!\p{L})|есть\s+(?:время|место)/iu;

/**
 * Цитаты, которые окошком не являются, даже если слово «окошко» в них есть.
 *
 * Напоминание о записи и наши собственные ответы («окошко уже заняли»,
 * «закреплено за вами»): пациент отвечает на них свайпом, и принять такой
 * ответ за новую просьбу значило бы разбирать собственную реплику агента.
 * Остальные наши реплики об окошке узнаются точнее — по совпадению с тем, что
 * агент сам отправил (`clinic-agent`): общие слова вроде «удобнее» или
 * «запишем» бывают и в настоящем статусе клиники.
 */
const NOT_OFFER =
  /(?<!\p{L})(?:записаны|записан[аоы]?|ваша\s+запись|напомина\p{L}*|подтвердите|уже\s+заняли|закреплен\p{L}*|закрепили|уже\s+прошло)(?!\p{L})/iu;

/**
 * Время: 09:40, 9:40. Точку намеренно не берём: «12.09» — это и 12:09, и 12
 * сентября, а ошибиться здесь — значит назвать человеку не то время.
 */
const TIME = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g;

/** «12:15–13:00», «с 12:15 до 13:00» — одно окошко, а не два. */
const RANGE =
  /(?<![\d:])(?:с\s*)?([01]?\d|2[0-3]):([0-5]\d)\s*(?:[-–—]|до)\s*([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/giu;

export function timesIn(text: string): number[] {
  const ends = new Set<number>();
  for (const m of text.matchAll(RANGE)) ends.add(Number(m[3]) * 60 + Number(m[4]));
  const starts = new Set<number>();
  for (const m of text.matchAll(RANGE)) starts.add(Number(m[1]) * 60 + Number(m[2]));

  const out = new Set<number>();
  for (const m of text.matchAll(TIME)) {
    const minute = Number(m[1]) * 60 + Number(m[2]);
    // Конец промежутка — не отдельное окошко, если только он сам не начало другого.
    if (ends.has(minute) && !starts.has(minute)) continue;
    out.add(minute);
  }
  return [...out].sort((a, b) => a - b);
}

const WEEKDAYS: { day: number; re: RegExp }[] = [
  { day: 1, re: /(?<!\p{L})(?:понедельник\p{L}*|пн)(?!\p{L})/iu },
  { day: 2, re: /(?<!\p{L})(?:вторник\p{L}*|вт)(?!\p{L})/iu },
  { day: 3, re: /(?<!\p{L})(?:сред[ауые]|ср)(?!\p{L})/iu },
  { day: 4, re: /(?<!\p{L})(?:четверг\p{L}*|чт)(?!\p{L})/iu },
  { day: 5, re: /(?<!\p{L})(?:пятниц\p{L}*|пт)(?!\p{L})/iu },
  { day: 6, re: /(?<!\p{L})(?:суббот\p{L}*|сб)(?!\p{L})/iu },
  { day: 7, re: /(?<!\p{L})(?:воскресень\p{L}*|вс)(?!\p{L})/iu },
];

const MONTHS = [
  "январ", "феврал", "март", "апрел", "ма[йя]", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр",
];

/** Дата: «30.09», «30/09», «30 сентября». Год не нужен — он подбирается ближайший. */
export function explicitDate(text: string): { day: number; month: number } | null {
  const found: { day: number; month: number }[] = [];
  for (const m of text.matchAll(/(?<![\d:.])(\d{1,2})[./](\d{1,2})(?:[./]\d{2,4})?(?![\d:])/g)) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) found.push({ day, month });
  }
  MONTHS.forEach((stem, i) => {
    const re = new RegExp(`(?<![\\d])(\\d{1,2})\\s+${stem}\\p{L}*`, "giu");
    for (const m of text.matchAll(re)) {
      const day = Number(m[1]);
      if (day >= 1 && day <= 31) found.push({ day, month: i + 1 });
    }
  });
  const unique = [...new Map(found.map((d) => [`${d.day}.${d.month}`, d])).values()];
  // Две разные даты в одном статусе — какую имели в виду, неизвестно.
  return unique.length === 1 ? unique[0] : null;
}

export function daySpecIn(text: string): DaySpec | null {
  const date = explicitDate(text);
  if (date) return { kind: "date", ...date };

  const weekdays = WEEKDAYS.filter((w) => w.re.test(text)).map((w) => w.day);
  if (weekdays.length === 1) return { kind: "weekday", weekday: weekdays[0] };
  if (weekdays.length > 1) return null;

  const t = norm(text);
  if (/(?<!\p{L})послезавтра(?!\p{L})/u.test(t)) return { kind: "relative", offset: 2 };
  if (/(?<!\p{L})завтра(?!\p{L})/u.test(t)) return { kind: "relative", offset: 1 };
  if (/(?<!\p{L})сегодня(?!\p{L})/u.test(t)) return { kind: "relative", offset: 0 };
  return null;
}

export function audienceIn(text: string): "child" | "adult" | null {
  const child = /(?<!\p{L})(?:детск\p{L}*|дет[иейя]\p{L}*|ребен\p{L}*|ребён\p{L}*|малыш\p{L}*|младен\p{L}*)/iu.test(text);
  const adult = /(?<!\p{L})взросл\p{L}*/iu.test(text);
  if (child === adult) return null;
  return child ? "child" : "adult";
}

/**
 * Название клиники — не врач.
 *
 * «Клиника доктора Алункачевой» совпадает с фамилией Ирины Алилгаджиевны, и
 * статус «Клиника Алункачевой: окошко на завтра 12:15» без этой чистки
 * назначал окошко ей — при том что врача в статусе не называли.
 */
function withoutBrand(text: string): string {
  return text
    .replace(/клиник\p{L}*(?:\s+доктора)?\s+алункачев\p{L}*/giu, " ")
    .replace(/алункачев\p{L}*\s+клиник\p{L}*/giu, " ");
}

/**
 * Основы слов имени: первые пять букв, но всегда короче самого слова.
 *
 * У короткого имени пять букв — это всё слово: «ирина» не находилась в «к
 * Ирине», и статус «окошко к Ирине» выглядел как статус без врача. Падеж
 * меняет окончание, поэтому основа обязана его не захватывать.
 */
function nameStems(name: string): string[] {
  return norm(name)
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .map((w) => w.slice(0, Math.min(5, w.length - 1)));
}

/**
 * Врач из статуса — только однозначный.
 *
 * Правило то же, что у `uniqueStaffAsked`: побеждает тот, у кого совпало
 * больше слов имени, — «к Ирине Алилгаджиевне» различает двух Ирин. Но статус
 * может называть и ДВУХ врачей («10:00 к Ирине Алилгаджиевне, 15:00 к
 * Разият»): тогда какое время чьё, из текста не понять, и врача мы не
 * назначаем никому.
 */
export function staffInStatus<T extends SlotStaff>(text: string, staff: T[]): { staff: T | null; ambiguous: boolean } {
  const t = norm(withoutBrand(text));
  const hitsOf = (s: T) => nameStems(s.name).filter((stem) => new RegExp(`(?<!\\p{L})${stem}`, "u").test(t));
  const matched = staff.map((s) => ({ s, hits: hitsOf(s) })).filter((x) => x.hits.length > 0);
  if (matched.length === 0) return { staff: null, ambiguous: false };

  const best = Math.max(...matched.map((x) => x.hits.length));
  const top = matched.filter((x) => x.hits.length === best);
  if (top.length > 1) return { staff: null, ambiguous: true };

  const winner = top[0];
  const own = new Set(winner.hits);
  // Кто-то ещё назван словом, которого в имени победителя нет, — второй врач.
  const another = matched.some((x) => x !== winner && x.hits.some((h) => !own.has(h)));
  if (another) return { staff: null, ambiguous: true };
  return { staff: winner.s, ambiguous: false };
}

/**
 * Похоже ли на предложение окошка — без справочника врачей.
 *
 * Нужно раньше полного разбора: ответ «Ок» на статус с окошком — это «беру», а
 * не вежливость, и правило молчания на вежливость (`nothingToAnswer`) не должно
 * его глушить.
 */
export function looksLikeOffer(text: string | null | undefined): boolean {
  if (!text) return false;
  return OFFER_WORDS.test(text) && !NOT_OFFER.test(text) && timesIn(text).length > 0;
}

/**
 * Разобрать статус. null — это не предложение свободного окошка или в нём нет
 * ни одного времени: тогда статус для агента просто цитата, как любая другая.
 */
export function parseStatusOffer<T extends SlotStaff>(text: string, staff: T[]): StatusOffer<T> | null {
  if (!OFFER_WORDS.test(text) || NOT_OFFER.test(text)) return null;
  const times = timesIn(text);
  if (times.length === 0) return null;
  const who = staffInStatus(text, staff);
  return {
    staff: who.staff,
    staffAmbiguous: who.ambiguous,
    times,
    day: daySpecIn(text),
    audience: audienceIn(text),
  };
}

// ─────────────────────────────────────────── даты

/** «ГГГГ-ММ-ДД» + сколько-то суток. */
export function shiftDateKey(key: string, days: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** День недели даты: 1 = понедельник … 7 = воскресенье. */
export function weekdayOfKey(key: string): number {
  const d = new Date(`${key}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Момент: дата клиники и минута её суток. */
export function clinicMoment(key: string, minute: number, tz: string = CLINIC_TZ): Date {
  // Полдень UTC лежит внутри тех же суток клиники для любого пояса от −11 до +11.
  const start = startOfClinicDay(new Date(`${key}T12:00:00Z`), tz);
  return new Date(start.getTime() + minute * 60_000);
}

export interface DayCandidates {
  keys: string[];
  /**
   * День известен точно. false — вывели его сами, и назвать пациенту как факт
   * нельзя: сначала переспрашиваем.
   */
  certain: boolean;
}

/**
 * На какой день окошко.
 *
 * «На завтра» — это завтра ОТНОСИТЕЛЬНО ПУБЛИКАЦИИ статуса, а не ответа на
 * него. Статус живёт сутки: выложенный вечером «на завтра» и прочитанный утром
 * — это сегодня. Время публикации цитата не несёт; если его удалось узнать
 * (`postedAt`), день точный. Если нет — годятся два дня, и какой из них, решает
 * пациент, а не мы.
 */
export function candidateDays(
  day: DaySpec | null,
  ref: { postedAt: Date | null; now: Date },
  tz: string = CLINIC_TZ,
): DayCandidates {
  const base = clinicDateKey(ref.postedAt ?? ref.now, tz);
  const today = clinicDateKey(ref.now, tz);

  if (day?.kind === "relative") {
    if (ref.postedAt) return { keys: [shiftDateKey(base, day.offset)], certain: true };
    // Статус мог быть выложен сегодня или вчера — оба дня возможны.
    return {
      keys: [...new Set([shiftDateKey(today, day.offset - 1), shiftDateKey(today, day.offset)])],
      certain: false,
    };
  }

  if (day?.kind === "weekday") {
    // Ближайший такой день, начиная с дня публикации: статусы — про ближайшие дни.
    for (let i = 0; i < 7; i += 1) {
      const key = shiftDateKey(base, i);
      if (weekdayOfKey(key) === day.weekday) return { keys: [key], certain: true };
    }
  }

  if (day?.kind === "date") {
    const year = Number(base.slice(0, 4));
    const mk = (y: number) => `${y}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
    let key = mk(year);
    // Несуществующая дата («31.09») — не наша забота угадывать, что имели в виду.
    if (new Date(`${key}T12:00:00Z`).toISOString().slice(0, 10) !== key) return { keys: [], certain: true };
    // Декабрьский статус про январь.
    if (key < shiftDateKey(base, -180)) key = mk(year + 1);
    return { keys: [key], certain: true };
  }

  /**
   * День не назван: «Окошко к Ирине 12:15».
   *
   * Зная, когда статус выложен, берём ближайшее такое время после публикации:
   * вечером «12:15» — это завтра. Не зная — сегодня или завтра, спросим.
   */
  if (ref.postedAt) return { keys: [base], certain: true };
  return { keys: [today, shiftDateKey(today, 1)], certain: false };
}

export interface SlotCandidate {
  key: string;
  minute: number;
  at: Date;
}

/**
 * Все окошки, о которых может идти речь: дни × времена.
 *
 * Прошедшие отделены от будущих: «уже прошло» — это ответ, а не повод
 * предлагать то же время на другой день.
 */
export function slotCandidates(
  keys: string[],
  minutes: number[],
  ref: { postedAt: Date | null; now: Date },
  tz: string = CLINIC_TZ,
  /**
   * День в статусе не назван, а время публикации известно. Только в этом
   * случае «12:15», уже прошедшее к моменту публикации, означает завтра: если
   * день назван («на сегодня 12:15»), такой статус противоречит сам себе, и
   * переносить его на другой день мы не вправе — это «уже прошло».
   */
  rollAfterPost = false,
): { future: SlotCandidate[]; past: SlotCandidate[] } {
  const future: SlotCandidate[] = [];
  const past: SlotCandidate[] = [];
  for (const key of keys) {
    for (const minute of minutes) {
      const at = clinicMoment(key, minute, tz);
      if (rollAfterPost && ref.postedAt && at <= ref.postedAt) {
        const next = clinicMoment(shiftDateKey(key, 1), minute, tz);
        (next > ref.now ? future : past).push({ key: shiftDateKey(key, 1), minute, at: next });
        continue;
      }
      (at > ref.now ? future : past).push({ key, minute, at });
    }
  }
  const sort = (a: SlotCandidate, b: SlotCandidate) => a.at.getTime() - b.at.getTime();
  return { future: future.sort(sort), past: past.sort(sort) };
}

// ─────────────────────────────────────────── слова пациента

/**
 * Пациент отказывается или пишет не про окошко.
 *
 * «Не надо, спасибо», «уже не актуально», «передумала» — закреплять нечего.
 */
const DECLINES =
  /(?<!\p{L})(?:не\s+(?:надо|нужно|актуальн\p{L}*|смогу|сможем|получится|подходит|интересно|хочу|будем)|нет,?\s+спасибо|передумал\p{L}*|отмен\p{L}*)(?!\p{L})/iu;

/**
 * Пациент хочет это окошко.
 *
 * Ответ на статус с окошком сам по себе и есть просьба: «Хочу», «Можно?»,
 * «Свободно ещё?», «+». Просто «спасибо» просьбой не считаем — это вежливость.
 */
const WANTS =
  /(?<!\p{L})(?:хочу|хотим|хотел\p{L}*|запиш\p{L}*|записать|записаться|можно|свобод\p{L}*|актуальн\p{L}*|беру|берем|берём|возьм\p{L}*|давайте|да|ок|окей|ok|забронир\p{L}*|займ\p{L}*|занять|нам|мне|меня|нас|еще|ещё|есть|подходит|подойд\p{L}*|удобно|успеем|готов\p{L}*|актуально)(?!\p{L})|\+|👍|✅/iu;

export function declinesSlot(own: string): boolean {
  return DECLINES.test(own);
}

export function wantsSlot(own: string): boolean {
  if (declinesSlot(own)) return false;
  return WANTS.test(own) || timesIn(own).length > 0;
}

/**
 * Записывают не себя.
 *
 * «Запишите сына», «племянника», «для мамы», «запишите Амину» — окошко нужно
 * другому человеку, и его данных у клиники нет. Правило нарочно широкое:
 * ошибка в эту сторону стоит одного вопроса, ошибка в другую — окошка,
 * закреплённого за человеком, который не придёт.
 */
const SOMEONE_ELSE =
  /(?<!\p{L})(?:ребен\p{L}*|ребён\p{L}*|дет[иейя]\p{L}*|сын\p{L}*|доч\p{L}*|племянн\p{L}*|внук\p{L}*|внучк\p{L}*|муж|мужа|мужу|мужем|жен[аеуы]|мам[аеуы]?|маму|пап[аеуы]?|брат\p{L}*|сестр\p{L}*|подруг\p{L}*|друг[ау]?|бабушк\p{L}*|дедушк\p{L}*|свекр\p{L}*|малыш\p{L}*|девочк\p{L}*|мальчик\p{L}*|родственн\p{L}*|знаком\p{L}*)(?!\p{L})/iu;

export function forSomeoneElse(own: string): boolean {
  if (SOMEONE_ELSE.test(own)) return true;
  if (/(?:запиш\p{L}*|записать)\s+(?:его|её|ее|их)(?!\p{L})/iu.test(own)) return true;
  /**
   * «Запишите Амину» — имя с заглавной буквы после просьбы записать. Регистр
   * здесь важен, поэтому без флага i. «Запишите Пожалуйста» — не имя: люди
   * пишут вежливость с заглавной, и принимать её за другого человека нельзя.
   */
  const named = /(?:[Зз]апиш\p{L}*|[Зз]аписать)[\s,]+(\p{Lu}\p{Ll}{2,})/u.exec(own);
  return named !== null && !NOT_A_NAME.test(named[1]);
}

const NOT_A_NAME = /^(?:Пожалуйст\p{L}*|Пож\p{L}*|Меня|Нас|Нам|Мне|Туда|Сюда|Тогда|Срочно|Можно|Если|Хочу|Хотим)$/u;

/**
 * Выбор пациента среди вариантов: время, день, «да» или «нет».
 *
 * Сегодня/завтра здесь — относительно ОТВЕТА пациента: он пишет сейчас и
 * говорит о своём завтра, а не о завтра статуса.
 */
export interface Pick {
  minutes: number[];
  /** Часы без минут: «в 12» — годится, только если так начинается ровно одно окошко. */
  hours: number[];
  keys: string[];
  /** Число месяца без месяца: «30-го». */
  days: number[];
  yes: boolean;
  no: boolean;
}

export function pickIn(own: string, now: Date, tz: string = CLINIC_TZ): Pick {
  const t = norm(own).trim();
  const today = clinicDateKey(now, tz);
  const keys = new Set<string>();
  if (/(?<!\p{L})послезавтра(?!\p{L})/u.test(t)) keys.add(shiftDateKey(today, 2));
  else if (/(?<!\p{L})завтра(?!\p{L})/u.test(t)) keys.add(shiftDateKey(today, 1));
  if (/(?<!\p{L})сегодня(?!\p{L})/u.test(t)) keys.add(today);
  for (const w of WEEKDAYS) {
    if (!w.re.test(own)) continue;
    for (let i = 0; i < 7; i += 1) {
      const key = shiftDateKey(today, i);
      if (weekdayOfKey(key) === w.day) {
        keys.add(key);
        break;
      }
    }
  }
  const date = explicitDate(own);
  if (date) {
    const year = Number(today.slice(0, 4));
    keys.add(`${year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`);
  }

  const minutes = timesIn(own);
  const hours: number[] = [];
  if (minutes.length === 0) {
    // «в 12», «на 9» — час без минут.
    for (const m of own.matchAll(/(?<![\d:])(?:в|на|к)\s+([01]?\d|2[0-3])(?![\d:])/giu)) hours.push(Number(m[1]));
  }
  const days: number[] = [];
  if (!date) for (const m of own.matchAll(/(?<![\d:])([12]?\d|3[01])(?:-?го|-?е)(?!\p{L})/giu)) days.push(Number(m[1]));

  const yes = /^(?:да|ага|угу|верно|конечно|подтверждаю|ок|окей|ok|\+|👍|хорошо|давайте|да,?\s+\S.*|да[.!]*)$/iu.test(t);
  const no = /^(?:нет|неверно|не\s+(?:верно|то|так))(?![\p{L}])/iu.test(t);
  return { minutes, hours, keys: [...keys], days, yes, no };
}

// ─────────────────────────────────────────── как назвать окошко

const WHEN = new Intl.DateTimeFormat("ru-RU", {
  timeZone: CLINIC_TZ,
  weekday: "short",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

const DAY = new Intl.DateTimeFormat("ru-RU", {
  timeZone: CLINIC_TZ,
  weekday: "short",
  day: "numeric",
  month: "long",
});

/** «вт, 30 сентября в 12:15» — так же, как запись в ответе «когда у меня запись». */
export function slotWhen(at: Date): string {
  return WHEN.format(at);
}

/** «вт, 30 сентября». */
export function dayWhen(at: Date): string {
  return DAY.format(at);
}

/** «12:15». */
export function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/**
 * Как назвать врача: словами самой клиники, если они есть в статусе.
 *
 * Склонять имена кодом нельзя — однажды это выйдет неправильно на чьей-нибудь
 * фамилии («к Ирина Алилгаджиевна»). Но в статусе клиника уже написала «к
 * Ирине Алилгаджиевне» — берём ровно это. Нет такого оборота — называем врача
 * как в справочнике, в скобках: не красиво, но без ошибки в имени.
 */
export function staffPhrase(statusText: string, staff: SlotStaff): string {
  const stems = nameStems(staff.name);
  /**
   * Между «к» и именем бывает специальность со строчной буквы: «Окошки на
   * завтра к остеопату Разият Ризвановне» — так пишет клиника. Берём оборот
   * целиком, вместе со специальностью: это её слова, и склонены они верно.
   */
  for (const m of statusText.matchAll(
    /(?<!\p{L})[кК]\s+((?:\p{Ll}+\s+){0,2})(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+){0,2})/gu,
  )) {
    const words = norm(m[2]).split(/\s+/);
    if (words.every((w) => stems.some((st) => w.startsWith(st)))) {
      return `к ${m[1].replace(/\s+/g, " ")}${m[2].replace(/\s+/g, " ")}`;
    }
  }
  return `(${staff.name})`;
}
