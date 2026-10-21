/**
 * Акция клиники в разговоре агента — правила без базы и без модели.
 *
 * Главная защита от утечки — данные, а не промпт. Текст акции в системный
 * промпт НЕ зашивается: агент знает об акции только из записей справочника,
 * привязанных к акции (`KnowledgeEntry.promoId`), и эти записи попадают в
 * контекст лишь при трёх условиях сразу:
 *   — акция включена, уже началась и ещё не закончилась (`promoVisible`);
 *   — у акции стоит «агент знает» (`agentEnabled`);
 *   — пациент в текущем разговоре сам о ней заговорил (`promoTriggered`).
 * Кончилась акция — агент замолчал о ней сам, без правки промпта. Во всех
 * прочих разговорах (остеопатия у взрослых, капельницы, БОС, запись, цены)
 * акции для агента не существует.
 */

import { hasMarker } from "@/lib/metrics/promo-marker";

/** Вопрос про школу — дословно один: по нему же узнаём, что уже спрашивали. */
export const SCHOOL_QUESTION = "Подскажите, вы узнали о нас от школы подготовки?";

const CHILD = /(?<!\p{L})(?:реб[её]н\p{L}*|дет\p{L}*|сын\p{L}*|доч\p{L}*|школьни\p{L}*|ученик\p{L}*|учениц\p{L}*|мальчик\p{L}*|девочк\p{L}*)/iu;
const EXAM = /(?<!\p{L})(?:обследова\p{L}*|обследован\p{L}*|чек\p{L}*\s+здоровь\p{L}*|провер\p{L}*\s+здоровь\p{L}*|комплексн\p{L}*\s+провер\p{L}*)/iu;
const EXPLICIT = [
  /(?<![\p{L}])check[\s-]?up(?!\p{L})/iu,
  /**
   * Чек-ап во всех написаниях: «чек-ап», «чекап», «чек ап», «чек апа» и с
   * опечатками — «чека ап», «чэк ап», «чек апп». Живой диалог 21 октября:
   * «если девочке 16 лет, нам уже не подходит этот чека ап?» не узнавался, и
   * модель ответила, что такой услуги нет.
   */
  /(?<!\p{L})ч[еэ]к(?:а|у|ом|е)?[\s-]*ап+\p{L}*/iu,
  /(?<!\p{L})школьн\p{L}*/iu,
  /(?<!\p{L})акци\p{L}*/iu,
  // Название в YCLIENTS — «Школьный ресурс 6+». Голое «ресурс» не берём: у клиники
  // инфузии «Био-Ресурс» и «Абсолютный ресурс», и вопрос о них открыл бы акцию.
  /(?<!\p{L})ресурс\p{L}*\s*6\s*\+?/iu,
];

export interface AgeRange {
  ageMin: number | null;
  ageMax: number | null;
}

/**
 * Возрасты детей, названные человеком, в годах (месяцы — ноль лет).
 * «Мне 34 года» — возраст родителя, не ребёнка: такие числа пропускаем.
 */
export function statedChildAges(texts: string[]): number[] {
  const ages: number[] = [];
  for (const t of texts) {
    const re = /(\d{1,2})(?:[.,]\d)?\s*(?:-?\s*)?(лет|год\p{L}*|г\.|мес\p{L}*)(?!\p{L})/giu;
    for (const m of t.matchAll(re)) {
      // Целиком до числа, а не обрезок: обрезок «я для ребёнка» видел «я» в «для».
      const before = t.slice(0, m.index ?? 0);
      if (/(?<!\p{L})(?:мне|я)(?:\s+(?:уже|только|ещё|еще|почти))?\s*$/iu.test(before)) continue;
      ages.push(/^мес/iu.test(m[2]) ? 0 : Number(m[1]));
    }
  }
  return ages;
}

/** Хоть один названный возраст ребёнка вне границ акции. */
export function ageOutside(ages: number[], range: AgeRange): boolean {
  return ages.some(
    (a) => (range.ageMin != null && a < range.ageMin) || (range.ageMax != null && a > range.ageMax),
  );
}

/**
 * Заговорил ли человек об акции сам.
 *
 * Прямые слова: check-up, чек-ап, «школьн…», «акци…». Или вопрос об
 * обследовании ребёнка школьного возраста — со словом о ребёнке и возрастом в
 * границах акции либо словом «школьник». Ребёнок 3 лет на «обследовать» акцию
 * не зажигает: это не школьный возраст.
 */
export function promoTriggered(text: string, range: AgeRange = { ageMin: 6, ageMax: 14 }): boolean {
  if (EXPLICIT.some((re) => re.test(text))) return true;
  if (!EXAM.test(text) || !CHILD.test(text)) return false;
  if (/(?<!\p{L})(?:школьни\p{L}*|в\s+школу|первоклас\p{L}*)/iu.test(text)) return true;
  const ages = statedChildAges([text]);
  return ages.length > 0 && !ageOutside(ages, range);
}

export interface PromoGate {
  isActive: boolean;
  agentEnabled: boolean;
  startsAt: Date;
  endsAt: Date;
}

/** Акция видна агенту: включена, «агент знает», сегодня между началом и концом. */
export function promoVisible(promo: PromoGate, now: Date): boolean {
  return (
    promo.isActive &&
    promo.agentEnabled &&
    now.getTime() >= promo.startsAt.getTime() &&
    now.getTime() <= promo.endsAt.getTime()
  );
}

export interface PromoForAgent<E> extends PromoGate, AgeRange {
  id: string;
  entries: E[];
  /** Метка из ссылки школы («[ШК]»): сообщение с ней — тоже разговор об акции. */
  waMarker?: string;
}

/**
 * Акции, которые агент видит в ЭТОМ разговоре, с их записями справочника.
 * Акция без записей справочника агенту не видна вовсе: знать о ней ему
 * неоткуда, а сочинять нельзя.
 *
 * `patientTexts` — слова пациента за текущий разговор (без цитат клиники):
 * «а сколько длится?» после «что за школьный чек-ап?» — всё ещё про акцию.
 */
export function visiblePromos<P extends PromoForAgent<unknown>>(promos: P[], patientTexts: string[], now: Date): P[] {
  return promos.filter(
    (p) =>
      p.entries.length > 0 &&
      promoVisible(p, now) &&
      patientTexts.some((t) => promoTriggered(t, p) || (p.waMarker ? hasMarker(t, p.waMarker) : false)),
  );
}

/** Спрашивали ли уже про школу — в любой нашей реплике за всю переписку. */
export function askedSchool(agentTexts: string[]): boolean {
  const key = SCHOOL_QUESTION.slice(0, 40).toLowerCase();
  return agentTexts.some((t) => t.toLowerCase().includes(key));
}

/**
 * Вопрос про школу — один раз, только тем, кто ещё не привязан и пришёл без
 * метки. Ответ привязку НЕ создаёт: он остаётся в переписке уликой, и её
 * найдёт разбор переписки — с подтверждением человеком (п. 8 спецификации).
 */
export function shouldAskSchool(input: { agentTexts: string[]; attributed: boolean; schools: number; marked?: boolean }): boolean {
  return input.schools > 0 && !input.attributed && !input.marked && !askedSchool(input.agentTexts);
}

// ─────────────────────────────────────────────── ответ про школу

export type SchoolMatch =
  | { kind: "match"; schoolId: string }
  | { kind: "ambiguous"; schoolIds: string[] }
  | { kind: "declined" }
  | { kind: "unknown" };

const GENERIC = new Set(
  [
    "школа", "школы", "школе", "школу", "школой", "школ", "подготовки", "подготовка", "подготовке", "подготовку",
    "центр", "центра", "центре", "детский", "детского", "детской", "развития", "раннего", "клуб", "клуба",
    "студия", "студии", "сад", "сада", "садик", "садика", "от", "из", "мы", "нас", "вас", "узнали", "через",
    "по", "при", "для", "это", "да", "нам", "посоветовали", "сказали", "гимназия", "гимназии", "лицей", "лицея",
  ].map((w) => w.normalize("NFC")),
);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\d]+/u)
    .filter(Boolean);
}

function distinctive(name: string): string[] {
  return words(name).filter((w) => (/^\d+$/.test(w) || w.length >= 3) && !GENERIC.has(w));
}

/** Слово ответа совпадает со словом названия с точностью до окончания: «Ростка» — «Росток». */
function sameWord(a: string, b: string): boolean {
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return a === b;
  const stem = b.slice(0, Math.max(4, b.length - 2));
  return a.startsWith(stem) || b.startsWith(a.slice(0, Math.max(4, a.length - 2)));
}

const DECLINED =
  /^(?:нет|неа|нет,|не\s+от|не\s+из|не\s+через|не\s+школ|не\s+помню|не\s+знаю|сам[аи]?|сами\s+наш|из\s+инстаграм|в\s+инстаграм|инстаграм|instagram|реклам|по\s+реклам|знаком|от\s+знаком|подруг|от\s+подруг|интернет|в\s+интернет|по\s+сарафан|друз)/iu;

/**
 * Сопоставить ответ человека со школами акции. Только АКТИВНЫЕ школы, только
 * однозначное совпадение: «похожую» школу агент не берёт и не выдумывает.
 * Совпадение — все отличительные слова названия есть в ответе (номер — точно).
 */
export function matchSchool(answer: string, schools: { id: string; name: string }[]): SchoolMatch {
  const said = words(answer);
  const hits = schools.filter((s) => {
    const key = distinctive(s.name);
    if (key.length === 0) return false;
    return key.every((k) => said.some((w) => sameWord(w, k)));
  });
  if (hits.length === 1) return { kind: "match", schoolId: hits[0].id };
  if (hits.length > 1) return { kind: "ambiguous", schoolIds: hits.map((h) => h.id) };
  if (DECLINED.test(answer.trim())) return { kind: "declined" };
  return { kind: "unknown" };
}
