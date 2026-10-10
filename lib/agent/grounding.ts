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

/**
 * Ответ без предложений, где стоит число не из справки. Решать, хватает ли
 * остатка, — вызывающему: он знает, о чём спрашивали.
 */
export function withoutUngroundedSentences(answer: string, context: string): string {
  return answer
    .split(/(?<=[.!?\n])/)
    .filter((sentence) => ungroundedNumbers(sentence, context).length === 0)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

/**
 * Денежные условия, которых нет в справке: «отмена позже может быть платной»,
 * «предоплата не возвращается», «удерживается штраф».
 *
 * Прогон 7 октября: на «за сколько можно бесплатно отменить?» модель ответила
 * справкой («предупредите за 3 часа») и приписала от себя «отмена позже этого
 * времени может быть платной». В справке клиники об этом ни слова. Число такая
 * фраза может и не содержать, поэтому проверка чисел её не видит, а для
 * пациента это условие клиники про его деньги. Каждое такое слово обязано
 * стоять в справке; нет — предложение убирается. Слова пациента основанием не
 * считаются, как и везде.
 */
const MONEY_TERM =
  /(?<!\p{L})(?:платн\p{L}*|штраф\p{L}*|удерж\p{L}*|предоплат\p{L}*|неустойк\p{L}*|невозвратн\p{L}*|не\s+возвра[щт]\p{L}*|списыва\p{L}*|списан\p{L}*|оплачива\p{L}*)(?!\p{L})/giu;

export function ungroundedMoneyTerms(answer: string, reference: string): string[] {
  const ref = reference.toLowerCase().replace(/ё/g, "е");
  const stem = (w: string) => w.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").slice(0, 6);
  /**
   * «Диагностика оплачивается отдельно и стоит 1000 ₽» — рассказ о прайсе, а не
   * условие: цена в той же фразе стоит в справке (прогон на боевом снимке, 10
   * октября: на «Диагностика отдельно оплачивается?» вырезался сам ответ). Так —
   * только для нейтрального «оплачивается»; «платно», «штраф» строги всегда.
   */
  const refNumbers = new Set((ref.match(/\d[\d\s ]*\d|\d/g) ?? []).map((n) => n.replace(/[\s ]/g, "")));
  const pricedHere = (answer.match(/\d[\d\s ]*\d|\d/g) ?? [])
    .map((n) => n.replace(/[\s ]/g, ""))
    .some((n) => n.length >= 3 && refNumbers.has(n));
  return [...answer.matchAll(MONEY_TERM)]
    .map((m) => m[0])
    .filter((w) => !ref.includes(stem(w)))
    .filter((w) => !(pricedHere && /^оплачива/iu.test(w)));
}

export function withoutUngroundedMoneyTerms(answer: string, reference: string): string {
  return answer
    .split(/(?<=[.!?\n])/)
    .filter((sentence) => ungroundedMoneyTerms(sentence, reference).length === 0)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Слова не того алфавита — сбой модели, а не ответ.
 *
 * Живые ответы: «Ва iyyaka 🌿» (Haiku 4.5, 9 октября) и «Ваalaйкум ассалям!»
 * (Haiku 5.5, прогон того же дня). Пациент видит латиницу посреди русской
 * фразы и понимает, что пишет программа, причём сломанная.
 *
 * Сбоем считаем: слово, где перемешаны латиница и кириллица; латинское слово
 * от трёх букв, которого нет ни в справке, ни в переписке («IV-терапия»,
 * «BRAINBI» стоят в справке — их не трогаем); слово другого письма (арабского
 * и т. п.), которого нет там же. Ссылки и почта проверяются отдельно
 * (`ungroundedLinks`) и здесь не разбираются.
 */
const KNOWN_LATIN = new Set(["whatsapp", "telegram", "instagram", "viber", "email", "sms", "wi", "fi", "wifi"]);

export function foreignScriptWords(answer: string, allowed: string): string[] {
  const text = answer.replace(/https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.]+/giu, " ");
  const known = allowed.toLowerCase();
  const out: string[] = [];
  for (const m of text.matchAll(/\p{L}+/gu)) {
    const w = m[0];
    const latin = /[a-z]/i.test(w);
    const cyrillic = /[Ѐ-ӿ]/.test(w);
    const other = /[^a-zЀ-ӿ]/i.test(w);
    if (latin && cyrillic) {
      out.push(w);
    } else if ((latin || other) && !cyrillic) {
      const lower = w.toLowerCase();
      if (latin && !other && (w.length < 3 || KNOWN_LATIN.has(lower))) continue;
      if (!known.includes(lower)) out.push(w);
    } else if (other && cyrillic) {
      out.push(w);
    }
  }
  return out;
}

/** Ответ без предложений, где есть слова не того алфавита. */
export function withoutForeignScript(answer: string, allowed: string): string {
  return answer
    // Точка внутри ссылки («alunkachevaclinic.ru») предложение не заканчивает.
    .split(/(?<=[.!?])(?=\s|$)|(?<=\n)/)
    .filter((sentence) => foreignScriptWords(sentence, allowed).length === 0)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * «В справке клиники нет», «по нашей справке» — служебные слова, пациенту не
 * уходят.
 *
 * Правило в промпте стоит давно, а Haiku 5.5 его не держит: на прогоне 9
 * октября «справка» звучала в каждом десятом ответе — «Скидок для инвалидов в
 * справке клиники нет, поэтому точно ответить не могу». Человек понимает, что
 * разговаривает с программой, которая читает документ. Просьбы здесь не
 * работают, поэтому чистим на выходе: предложение о том, чего в справке НЕТ,
 * убираем целиком (следом модель почти всегда пишет «уточню у
 * администратора»); в остальных снимаем сам оборот.
 */
const REFERENCE_WORD = /(?<!\p{L})справк\p{L}*/iu;
const REFERENCE_MISSING =
  /(?<!\p{L})(?:нет|не\s+(?:указан\p{L}*|сказано|видно|написано|могу|знаю|упомина\p{L}*|описан\p{L}*)|отсутству\p{L}*)(?!\p{L})/iu;
const REFERENCE_PHRASE =
  /(?<!\p{L})(?:по|согласно|судя\s+по|как\s+указано\s+в|в)\s+(?:нашей\s+|моей\s+)?справк\p{L}*(?:\s+клиники)?(?:\s+(?:указано|сказано|написано),?\s+что)?,?\s*/giu;

/**
 * «(в некоторых материалах клиники она указана как …)», «по другим источникам»
 * — рассуждение модели о наших документах (снимок боевых данных 9 октября).
 */
const SOURCES_TALK =
  /\s*\([^()]*(?:материал\p{L}*|источник\p{L}*|документ\p{L}*\s+клиники)[^()]*\)|(?<!\p{L})(?:по\s+другим\s+источникам|в\s+(?:некоторых|других)\s+(?:материалах|источниках)[^,.;]*),?\s*/giu;

export function withoutReferenceTalk(answer: string): string {
  answer = answer.replace(SOURCES_TALK, " ").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([.,;!?])/g, "$1");
  /**
   * «Количество сеансов в справке не указано, поэтому уточню у администратора»
   * — «не указано» переписываем, а не выбрасываем: следующее предложение модели
   * часто опирается на это («Так я смогу передать ему ваш вопрос…»), и без
   * него ответ начинался с середины мысли (прогон 9 октября). «Нет» не
   * переписываем: «скидок нет» — это уже утверждение о клинике.
   */
  const rewritten = answer.replace(
    /\s*(?<!\p{L})в\s+(?:нашей\s+|моей\s+)?справк\p{L}*(?:\s+клиники)?\s+не\s+(?:указан\p{L}*|сказано|написано|описан\p{L}*)/giu,
    " сказать заранее не могу",
  );
  const sentences = rewritten.split(/(?<=[.!?])(?=\s|$)|(?<=\n)/);
  /**
   * «У меня данных нет», «в моих данных этого нет» — та же служебная речь.
   * И замена «не указано» → «сказать заранее не могу» рядом с «поэтому точно
   * сказать не могу» даёт «Скидок сказать заранее не могу, поэтому точно
   * сказать не могу» (прогон 9 октября) — такое предложение убираем целиком.
   */
  /**
   * «По списку, который у меня есть, в пятницу никто не отмечен», «в списке её
   * приёмов это не указано», «в фактах их нет» — то же самое другими словами
   * (снимок боевых данных, 9 октября).
   */
  const MY_DATA =
    /(?<!\p{L})(?:в\s+моих\s+данных|у\s+меня\s+(?:нет\s+)?(?:точных\s+)?данных|данных\s+у\s+меня\s+нет|мне\s+не\s+известн\p{L}*|по\s+списку|в\s+списке\s+(?:\p{L}+\s+){0,2}(?:это\s+)?не\s+(?:указан\p{L}*|отмечен\p{L}*)|в\s+фактах)/iu;
  const doubled = (s: string) => /сказать\s+заранее\s+не\s+могу[^.!?]*не\s+могу/iu.test(s);
  // Предложение, опирающееся на выброшенное («Так…», «Поэтому…»), уходит вместе с ним.
  const dropped = sentences.map((s) => (REFERENCE_WORD.test(s) && REFERENCE_MISSING.test(s)) || MY_DATA.test(s) || doubled(s));
  const kept = sentences
    .filter((s, i) => !dropped[i] && !(i > 0 && dropped[i - 1] && /^\s*(?:так|поэтому|это|тогда|значит|из-за\s+этого)(?!\p{L})/iu.test(s)))
    .map((s) => {
      if (!REFERENCE_WORD.test(s)) return s;
      const cleaned = s.replace(REFERENCE_PHRASE, " ").replace(/\s{2,}/g, " ");
      // Предложение начиналось с оборота — заглавная буква у того, что осталось.
      return cleaned.replace(/^(\s*)(\p{Ll})/u, (_m, sp: string, ch: string) => sp + ch.toUpperCase());
    })
    .filter((s) => !REFERENCE_WORD.test(s));
  const out = kept.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // Остаток начинается с отсылки к выброшенному («Он ответит…») — говорим, кто «он».
  if (dropped.some(Boolean) && /^(?:он|она|так|поэтому|это|тогда|значит)(?!\p{L})/iu.test(out) && !/администратор/iu.test(out)) {
    return `Уточню у администратора. ${out}`;
  }
  /**
   * Выброшенное предложение само передавало вопрос администратору («…в списке
   * не указано, поэтому уточню у администратора») — передача не должна
   * пропасть вместе с ним: человек останется с ответом «клиника работает» и без
   * ответа на свой вопрос.
   */
  const handedOver = sentences.some((s, i) => dropped[i] && /(?<!\p{L})(?:уточн\p{L}*|переда\p{L}*)[^.!?]{0,40}администратор/iu.test(s));
  if (handedOver && out && !/администратор/iu.test(out)) {
    return `${out}\n\nОстальное уточню у администратора — он ответит здесь же.`;
  }
  return out;
}

/**
 * «Поправлю своё прошлое сообщение: детской цены у Ирины нет» — модель
 * опровергает наши же ответы (прогон 9 октября). Цены и врачей в прошлых
 * репликах ставил код из прайса, а модели в этот раз ушла только часть строк —
 * «поправка» неверна, и человек получает два противоречащих сообщения подряд.
 */
const SELF_CORRECTION =
  /^\s*(?:поправлю|исправлю|уточню,\s+что\s+я|поправка|прошу\s+прощения,\s+я|извините,\s+я\s+(?:ошиб|неправ|невер)|я\s+ошиб\p{L}*|ранее\s+я\s+(?:ошиб|неверно|написал))/iu;

/**
 * Поправка себя посреди фразы и извинение за неё: «детский приём длится 40
 * минут, а не 30–40», «Простите за путаницу» (прогон на боевом снимке, 10
 * октября: на «ага» модель исправила собственную прошлую реплику, а следом
 * извинилась). Цифры у нас ставит код; спор модели с ними пациенту не нужен.
 */
const CORRECTION_INSIDE =
  /(?<!\p{L})а\s+не\s+\d|(?<!\p{L})(?:простите|извините|прошу\s+прощения)\s+за\s+(?:путаниц\p{L}*|неточност\p{L}*|ошибк\p{L}*)/iu;

export function withoutSelfCorrection(answer: string): string {
  const out = answer
    .split(/(?<=[.!?])(?=\s|$)|(?<=\n)/)
    .filter((sentence) => !SELF_CORRECTION.test(sentence) && !CORRECTION_INSIDE.test(sentence))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Ответ не начинается со строчной: «детский приём…» читается как обрывок.
  return out.replace(/^(\p{Ll})/u, (c) => c.toUpperCase());
}

/**
 * Вопрос, который мы уже задали прошлой репликой, второй раз не задаём.
 *
 * Снимок боевых данных 9 октября: человек прислал направление, спросил «что
 * взять с собой», потом «можно картой?» — и каждый ответ модели заканчивался
 * тем же «На какую услугу вы хотите записаться и для кого?». Он видел вопрос и
 * решил пока не отвечать; повтор читается как допрос автоответчика.
 *
 * Убираем только вопрос и только почти дословный (общих основ слов не меньше
 * двух третей), и только когда кроме него в ответе есть что-то по делу.
 */
export function withoutRepeatedQuestion(answer: string, lastAgent: string | undefined): string {
  if (!lastAgent) return answer;
  const stems = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/ё/g, "е")
        .split(/[^\p{L}]+/u)
        .filter((w) => w.length >= 3)
        .map((w) => w.slice(0, 5)),
    );
  const sentencesOf = (s: string) => s.split(/(?<=[.!?])(?=\s|$)|\n+/).map((x) => x.trim()).filter(Boolean);
  const before = sentencesOf(lastAgent).filter((x) => x.includes("?")).map(stems);
  if (before.length === 0) return answer;
  const same = (q: Set<string>) =>
    before.some((b) => {
      const common = [...q].filter((w) => b.has(w)).length;
      return q.size >= 3 && common / Math.max(q.size, b.size) >= 2 / 3;
    });
  const parts = sentencesOf(answer);
  const kept = parts.filter((x) => !(x.includes("?") && same(stems(x))));
  if (kept.length === parts.length || kept.length === 0) return answer;
  const out = kept.join(" ").trim();
  return out.length >= 12 ? out : answer;
}
