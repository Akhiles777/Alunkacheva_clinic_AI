/**
 * Длительность приёма — из справки клиники, а не из прайса YCLIENTS.
 *
 * Снимок боевых данных 9 октября: в прайсе «Остеопатия, приём Ирины» — 45 минут,
 * а в справочнике клиники «Взрослый приём — 8 000 ₽, длительность до 30 минут»
 * (и отдельная запись «Почему приём у Ирины длится всего 20–30 минут?»). Агент
 * печатал цены из прайса — и называл пациенту 45 минут, которые клиника сама
 * опровергает. В YCLIENTS это длина слота в расписании (с запасом), и менять её
 * там нельзя: поедет сетка записи.
 *
 * Поэтому длительность берём из справки, но только когда сопоставление
 * однозначно: строка справки стоит под врачом, в ней цена и длительность, и
 * в прайсе ровно одна услуга этого врача с этой ценой. Иначе — прайс, как был.
 */

const PRICE = /(\d{1,3}(?:[\s ]?\d{3})+|\d{3,6})\s*(?:₽|руб)/u;
const DURATION =
  /длительн\p{L}*[^\d\n]{0,20}?(\d{1,3})(?:\s*[–—-]\s*(\d{1,3}))?\s*мин/iu;

export interface DurationRow {
  id: string;
  title: string;
  price: number;
}

/** Слова имени, которые есть только у этого сотрудника: «Ирина» у двух Ирин не различает. */
function distinctWords(staffNames: string[]): Map<string, string[]> {
  const words = (n: string) =>
    n
      .toLowerCase()
      .replace(/ё/g, "е")
      .split(/[^\p{L}]+/u)
      .filter((w) => w.length >= 4);
  const count = new Map<string, number>();
  for (const n of staffNames) for (const w of new Set(words(n))) count.set(w, (count.get(w) ?? 0) + 1);
  return new Map(staffNames.map((n) => [n, words(n).filter((w) => count.get(w) === 1)]));
}

/** Имя врача в названии строки прайса — по началу имени: «приём Ирины», «прием Разият». */
function titleNames(title: string, staffName: string): boolean {
  const first = staffName
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 4);
  const t = title.toLowerCase().replace(/ё/g, "е");
  return first.some((w) => new RegExp(`(?<!\\p{L})${w.slice(0, Math.max(4, w.length - 1))}`, "u").test(t));
}

export function durationsFromKnowledge(
  answers: string[],
  staffNames: string[],
  services: DurationRow[],
): Map<string, number> {
  const distinct = distinctWords(staffNames);
  const out = new Map<string, number>();
  const conflicted = new Set<string>();
  for (const answer of answers) {
    let doctor: string | null = null;
    for (const raw of answer.split(/\n+/)) {
      const line = raw.toLowerCase().replace(/ё/g, "е");
      // По началу слова: «гаджиевна» (Сафия Гаджиевна) сидит внутри «Алилгаджиевна».
      const named = staffNames.filter((n) =>
        (distinct.get(n) ?? []).some((w) => new RegExp(`(?<!\\p{L})${w.slice(0, Math.max(4, w.length - 2))}`, "u").test(line)),
      );
      if (named.length === 1) doctor = named[0];
      else if (named.length > 1) doctor = null;
      if (!doctor) continue;
      const price = PRICE.exec(raw);
      const dur = DURATION.exec(raw);
      if (!price || !dur) continue;
      const value = Number(price[1].replace(/[\s ]/g, ""));
      const minutes = Number(dur[2] ?? dur[1]);
      if (!Number.isFinite(value) || minutes <= 0 || minutes > 240) continue;
      const rows = services.filter((s) => s.price === value && titleNames(s.title, doctor!));
      if (rows.length !== 1) continue;
      const id = rows[0].id;
      // Две записи справки называют разную длительность — не выбираем, остаётся прайс.
      if (out.has(id) && out.get(id) !== minutes) conflicted.add(id);
      out.set(id, minutes);
    }
  }
  for (const id of conflicted) out.delete(id);
  return out;
}
