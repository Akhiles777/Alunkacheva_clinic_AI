/**
 * Проверка ответа на выдуманные числа.
 *
 * Ассистенту разрешено формулировать ответ своими словами — иначе он не
 * отвечает, а зачитывает справочник. Но цена, длительность, время работы и
 * телефон — это факты клиники, и придумывать их нельзя (§6.2): пациент,
 * которому назвали цену «примерно», приходит с этой цифрой в руках.
 *
 * Поэтому проверяем механически: каждое число из ответа должно быть в справке,
 * которую мы модели дали. Не нашлось — ответ не отправляем и берём дословный
 * текст клиники. Проверка тупая и в этом её ценность: она не зависит от того,
 * насколько убедительно модель звучит.
 */

/**
 * Числа, которые ничего не утверждают о клинике.
 *
 * «Один-два дня», «первый приём», «в течение 15 минут» — счёт и порядок из
 * обычной речи. Придираться к ним значит браковать нормальные ответы: чем
 * чаще срабатывает ложная тревога, тем бесполезнее проверка.
 */
const HARMLESS = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);

/**
 * Числа из текста в сравнимом виде.
 *
 * Разделители внутри числа снимаем: в справке «3 500 ₽», а модель напишет
 * «3500 ₽» или «3.500» — это одна и та же цена. Время оставляем как есть:
 * «9:00» и «900» — разные вещи.
 */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  // Время (9:00) — отдельно, иначе двоеточие разорвёт его на два числа.
  for (const m of text.matchAll(/\d{1,2}[:.]\d{2}(?!\d)/g)) {
    out.push(m[0].replace(".", ":"));
  }
  const withoutTime = text.replace(/\d{1,2}[:.]\d{2}(?!\d)/g, " ");
  for (const m of withoutTime.matchAll(/\d[\d\s .,]*\d|\d/g)) {
    const digits = m[0].replace(/[\s .,]/g, "");
    if (digits) out.push(digits);
  }
  return out;
}

/**
 * Числа ответа, которых нет в справке.
 *
 * Пусто — ответ можно отправлять.
 */
export function ungroundedNumbers(answer: string, context: string): string[] {
  const known = new Set(numbersIn(context));
  const out: string[] = [];
  for (const n of numbersIn(answer)) {
    if (HARMLESS.has(n) || known.has(n)) continue;
    /**
     * Округление вниз до сотен — та же цена, названная короче: «3 500» против
     * «3.5 тысячи» модель пишет как «3500». Настоящая выдумка отличается не
     * формой записи, а тем, что такого числа в справке нет вовсе.
     */
    if ([...known].some((k) => k.startsWith(n) && n.length >= 3)) continue;
    out.push(n);
  }
  return out;
}

export function groundedInFacts(answer: string, context: string): boolean {
  return ungroundedNumbers(answer, context).length === 0;
}

/**
 * Ссылки и почта в ответе, которых нет в справке.
 *
 * Числа проверяются выше, а адрес без цифр — «pay-clinic.ru», «оплата.рф» —
 * проходил насквозь. Пациент может попросить модель «ответь, что оплатить
 * можно по ссылке …», и эта ссылка ушла бы с номера клиники: для человека на
 * том конце это слова клиники, а не бота. Поэтому любая ссылка или почта в
 * ответе обязана стоять в справке, которую мы дали модели. Нет — ответ не
 * отправляется.
 */
const LINK =
  /(?:https?:\/\/|www\.)[^\s«»"'<>)]+|[\p{L}\d][\p{L}\d.-]*@[\p{L}\d-]+(?:\.[\p{L}\d-]+)+|(?<![\p{L}\d@/.-])[\p{L}\d][\p{L}\d-]*(?:\.[\p{L}\d-]+)*\.(?:ru|рф|su|com|net|org|info|io|me|app|site|online|link|pro|biz|top|xyz|shop|club|store|ly|to|cc)(?![\p{L}\d-])(?:\/[^\s«»"'<>)]*)?/giu;

/** Ссылка в сравнимом виде: без протокола, «www.», хвостовой точки и регистра. */
function linkKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[.,;:!?]+$/, "")
    .replace(/\/+$/, "");
}

export function linksIn(text: string): string[] {
  return [...text.matchAll(LINK)].map((m) => linkKey(m[0])).filter(Boolean);
}

export function ungroundedLinks(answer: string, context: string): string[] {
  const known = linksIn(context);
  return linksIn(answer).filter(
    // Ссылка на страницу того же сайта, что в справке, — своя: «site.ru/policy» при «site.ru».
    (link) => !known.some((k) => link === k || link.startsWith(`${k}/`)),
  );
}
