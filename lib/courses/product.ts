import { normalizeTitle } from "@/lib/integrations/yclients/adopt";

/**
 * Цена курса, объявленная самой клиникой.
 *
 * В справочнике услуг рядом с «БОС-терапия» за 2 800 ₽ лежит «БОС-терапия,
 * курс» за 28 000 ₽ с пометкой «сеансов 10». Клиника уже сказала, сколько
 * стоит её курс, — и спрашивать об этом больше некого.
 *
 * До сих пор плановая цена курса считалась как цена сеанса × число сеансов.
 * Оценка работала, но была именно оценкой, и на услуге, у которой в карточке
 * стоит цена всего курса, давала 280 000 ₽ — курс по ней не собрался бы
 * никогда.
 *
 * Курсовая карточка узнаётся по двум признакам сразу: её название начинается с
 * названия обычной услуги и продолжается словом «курс», «пакет» или
 * «абонемент». Одного слова мало — «Пакет "PRO"» ни с чем не связан и сам по
 * себе услуга.
 *
 * Границы слова заданы явно, а не через `\b`: в JavaScript эта граница знает
 * только латиницу, и «курс» в русском названии она не находит вовсе.
 */
const COURSE_WORDS = /(^|[^\p{L}])(курс|пакет|абонемент)([^\p{L}]|$)/iu;

export interface ServiceRow {
  id: string;
  title: string;
  price: number;
  /** Размер курса из карточки: «сеансов 10». */
  sessions: number | null;
  /** Сколько приёмов было по этой услуге: у карточки-товара их не бывает. */
  visits: number;
}

/**
 * Вариант курса, объявленный клиникой: цена и число сеансов.
 *
 * Вариантов может быть несколько. Клиника вправе продавать и курс из четырёх
 * сеансов за 11 000 ₽, и курс из десяти за 28 000 ₽ — обе карточки лежат в
 * справочнике рядом. Одна плановая цена на услугу выкинула бы меньший курс:
 * 11 000 ₽ не дотягивают до половины двадцати восьми тысяч, и такая покупка
 * не считалась бы покупкой вовсе.
 */
export interface CoursePlanOption {
  price: number;
  sessions: number;
}

/**
 * Сопоставить обычной услуге цену её курса из справочника.
 *
 * Возвращает только надёжные пары: курсовая карточка без приёмов, у которой
 * ровно одна услуга-основа. Два кандидата — выбирать нельзя: свяжем не ту, и
 * платформа станет считать покупкой курса не ту сумму.
 */
export function coursePriceByService(
  services: ServiceRow[],
  /** Размер курса по умолчанию, если в карточке он не указан. */
  defaultSessions = 10,
): Map<string, CoursePlanOption[]> {
  const out = new Map<string, CoursePlanOption[]>();
  const bases = services.filter((s) => s.visits > 0 && normalizeTitle(s.title).length > 0);

  for (const product of services) {
    if (product.visits > 0) continue; // по этой услуге ходят — она не карточка курса
    if (product.price <= 0) continue;
    const title = normalizeTitle(product.title);
    if (!COURSE_WORDS.test(title)) continue;

    const matches = bases.filter((b) => {
      const base = normalizeTitle(b.title);
      if (base === title || !title.startsWith(base)) return false;
      // Продолжение должно быть отдельным словом, а не хвостом другого:
      // «бос-терапия» и «бос-терапия для детей» — разные услуги.
      return /^[\s,.:;-]/.test(title.slice(base.length));
    });
    // Самая длинная основа: «бос-терапия, курс» относится к «бос-терапия»,
    // а не к «бос» — если бы такая услуга нашлась.
    matches.sort((a, b) => normalizeTitle(b.title).length - normalizeTitle(a.title).length);
    const longest = matches[0];
    if (!longest) continue;
    const ties = matches.filter(
      (m) => normalizeTitle(m.title).length === normalizeTitle(longest.title).length,
    );
    if (ties.length !== 1) continue; // два одинаковых кандидата — не гадаем

    /**
     * Все варианты, а не самый дорогой.
     *
     * Клиника вправе продавать курс из четырёх сеансов и курс из десяти — обе
     * карточки лежат рядом. Оставить одну значило бы не узнавать покупку
     * второго курса: 11 000 ₽ не дотягивают до половины двадцати восьми тысяч.
     */
    const list = out.get(longest.id) ?? [];
    list.push({ price: product.price, sessions: product.sessions ?? defaultSessions });
    out.set(
      longest.id,
      // От дорогого к дешёвому: так их удобнее читать и в выводе, и в отладке.
      list.sort((a, b) => b.price - a.price),
    );
  }

  return out;
}
