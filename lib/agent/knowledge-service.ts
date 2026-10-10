/**
 * Услуга, которую клиника называет в справке, а в прайсе её под этим именем нет.
 *
 * Прогон на боевом снимке 9 октября: «Хочу записаться на ТРН» получало
 * предложение остеопатии с ценами двух врачей, а «Хочу записаться на Био-Старт»
 * — строки «Био-Ресурс 1000 ₽» и «NAD 9500 ₽». В прайсе ТРН заведена как
 * «Нейромедитация», а Био-Старт — пакетами «БАЗА» и «PRO»; зато в справке
 * клиники про обе написано прямо: «Курс ТРН — 10 процедур по 20 минут, 15 000 ₽»,
 * «Био-Старт: БАЗА — 7 000 ₽, PRO — 10 800 ₽».
 *
 * Подбор по прайсу тут врёт в обе стороны: не находит ничего — и предлагает
 * основную услугу, находит по половине слова («Био-…») — и называет чужую
 * цену. Поэтому такое имя услугу НАЗЫВАЕТ (шаг «на какую услугу» пройден), но
 * строку прайса не выбирает: цену и порядок берёт справка.
 *
 * Именем считаем только то, что похоже на имя, а не на обычное слово:
 * аббревиатуру, набранную заглавными («ТРН»), или составное слово через дефис
 * («Био-Старт»). Обычные слова — «капельница», «анализ» — подбираются по
 * прайсу, как прежде.
 */

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Кандидаты в имена услуги из слов пациента: «ТРН», «Био-Старт». */
function nameTokens(text: string): string[] {
  // Заглавными длиннее шести букв — это крик, а не аббревиатура.
  return [...text.matchAll(/(?<![\p{L}\d])(\p{L}{2,}(?:-\p{L}{2,})+|\p{Lu}{2,6})(?![\p{L}\d])/gu)].map((m) => m[1]);
}

/** Слово встречается в тексте отдельно: «ТРН» в «Курс ТРН», а не внутри другого слова. */
function hasWord(text: string, word: string): boolean {
  const w = norm(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\d])${w}`, "u").test(norm(text));
}

export interface KnowledgeText {
  topic: string;
  question: string;
  answer: string;
}

const PRICE = /\d[\d\s ]*\s*(?:₽|руб)/u;

/**
 * Услугой имя делает сама справка: оно стоит в теме или вопросе записи («Что
 * такое ТРН»), или в ответе рядом с ценой («Био-Старт: БАЗА — 7 000 ₽»).
 * Упоминание мимоходом — «возьмите с собой МРТ, КТ» — услугу не называет.
 */
function namesService(row: KnowledgeText, token: string): boolean {
  if (hasWord(row.topic, token) || hasWord(row.question, token)) return true;
  return hasWord(row.answer, token) && PRICE.test(row.answer);
}

/**
 * Капельница вообще — не строка прайса «Внутривенное капельное введение
 * растворов — 500 ₽». Это плата за само введение, а программа капельницы, по
 * справке клиники, стоит от 4 000 до 10 800 ₽, и начинать советуют с
 * «Био-Старта» (прогон на боевом снимке 9 октября: «Хочу на капельницу» без
 * модели получало «введение растворов — 500 ₽»). Названа конкретная инфузия
 * («Био-Ресурс») или свой препарат — подбор по прайсу, как прежде.
 */
const GENERIC_IV =
  /(?<!\p{L})(?:капельниц\p{L}*|прокапа\p{L}*|iv(?:-терапи\p{L}*)?|ив-терапи\p{L}*|инфузи\p{L}*)(?!\p{L})/iu;
const OWN_DRUG = /(?<!\p{L})(?:сво(?:й|и|его|ими?|ё|е)|препарат\p{L}*|раствор\p{L}*|укол\p{L}*|введени\p{L}*)(?!\p{L})/iu;
const IV_TITLE_WORDS = /^(?:внутривенн|капельн|введени|растворо|инфузи|терапи|струйн)/u;

function genericIv(text: string, knowledge: KnowledgeText[], serviceTitles: string[]): string | null {
  const m = GENERIC_IV.exec(text);
  if (!m || OWN_DRUG.test(text)) return null;
  // Конкретная инфузия названа: «Био-Ресурс», «NAD», «Ферро-Баланс».
  const specific = serviceTitles
    .flatMap((t) => norm(t).split(/[^\p{L}\d+]+/u))
    .filter((w) => w.length >= 3 && !IV_TITLE_WORDS.test(w) && !/^(?:iv|молекул|энерги|крови|спорт|выносливост)/u.test(w));
  const words = norm(text).split(/[^\p{L}\d+]+/u);
  if (words.some((w) => specific.some((s) => w.length >= 3 && (w === s || (s.length >= 5 && w.startsWith(s.slice(0, 5))))))) {
    return null;
  }
  const covered = knowledge.some((row) => GENERIC_IV.test(`${row.topic}\n${row.question}`) && PRICE.test(row.answer));
  return covered ? m[0] : null;
}

export function knowledgeOnlyService(text: string, knowledge: KnowledgeText[], serviceTitles: string[]): string | null {
  const iv = genericIv(text, knowledge, serviceTitles);
  if (iv) return iv;
  for (const token of nameTokens(text)) {
    if (serviceTitles.some((title) => hasWord(title, token))) continue;
    if (!knowledge.some((row) => namesService(row, token))) continue;
    return token;
  }
  return null;
}

/**
 * Названо сокращение, которого у клиники нет ни в прайсе, ни в справке: «МРТ»,
 * «УЗИ», «ЭЭГ». Снимок боевых данных 9 октября: «Сколько стоит МРТ?» получало
 * «Если вы про остеопатию — у нас принимают два врача…» — человек спросил
 * конкретное, а ему предложили другое. Отвечает модель: ей нельзя выдумывать,
 * и «такой услуги у нас нет» она скажет сама.
 */
const ASKS_FOR =
  /(?<!\p{L})(?:стоит|стоят|стоимость|цена|цену|почём|почем|на|делаете|делают|проводите|есть|сделать|пройти|сдать|записать\p{L}*|запишите)\s+(?:ли\s+)?(?:у\s+вас\s+)?$/iu;
const ASKED_AFTER = /^\s*(?:сколько|делаете|делают|проводите|есть|у\s+вас|можно|стоит|цена)(?!\p{L})/iu;

export function unknownServiceName(text: string, knowledge: KnowledgeText[], serviceTitles: string[]): string | null {
  for (const m of text.matchAll(/(?<![\p{L}\d])(\p{Lu}{2,6})(?![\p{L}\d])/gu)) {
    const token = m[1];
    // Только как предмет вопроса об услуге: «сколько стоит МРТ», «на МРТ», «УЗИ делаете?».
    // «При СДВГ», «взять ОАК» — диагноз и анализ в чужой фразе, не вопрос «есть ли у вас».
    const before = text.slice(0, m.index ?? 0);
    const after = text.slice((m.index ?? 0) + token.length);
    if (!ASKS_FOR.test(before) && !ASKED_AFTER.test(after)) continue;
    // Не услуги: ФИО, имена в капсе пишут редко, но «ОК», «ДА» — пишут.
    if (/^(?:ФИО|ОК|ДА|НЕТ|РФ|СМС)$/u.test(token)) continue;
    if (serviceTitles.some((title) => hasWord(title, token))) continue;
    if (knowledge.some((row) => namesService(row, token))) continue;
    return token;
  }
  return null;
}
