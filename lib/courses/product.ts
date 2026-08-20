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
  /** Сколько приёмов было по этой услуге: у карточки-товара их не бывает. */
  visits: number;
}

/**
 * Сопоставить обычной услуге цену её курса из справочника.
 *
 * Возвращает только надёжные пары: курсовая карточка без приёмов, у которой
 * ровно одна услуга-основа. Два кандидата — выбирать нельзя: свяжем не ту, и
 * платформа станет считать покупкой курса не ту сумму.
 */
export function coursePriceByService(services: ServiceRow[]): Map<string, number> {
  const out = new Map<string, number>();
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

    // Одна услуга могла обзавестись двумя курсовыми карточками: берём дороже
    // — курс из десяти сеансов дороже курса из четырёх, и он же полный.
    const known = out.get(longest.id) ?? 0;
    if (product.price > known) out.set(longest.id, product.price);
  }

  return out;
}
