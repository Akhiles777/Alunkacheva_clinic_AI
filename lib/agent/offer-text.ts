/**
 * Цены по врачам — так, как пишет их администратор клиники.
 *
 * Живой диалог 5 октября: на «Когда ближайшее окошко к вам на приём» агент
 * спросил «на какую услугу и для кого», а администратор следом ответил сам:
 *
 *   В нашей клинике ведут приём два врача-остеопата:
 *   Ирина Алилгаджиевна — взрослый 8000 ₽, детский 5000 ₽
 *   Разият Ризвановна — взрослый 5000 ₽, детский 4000 ₽
 *   Кому из врачей вас записать?
 *
 * Строки прайса как есть («Остеопатия - дети, прием Разият — 4000 ₽, 40 мин»)
 * читаются как выгрузка из программы; человек выбирает врача, и цены должны
 * стоять под врачом. Функция чистая: кто чей, решает вызывающий код.
 */

export interface OfferRow {
  title: string;
  price: number;
  durationMin: number;
  /** Кто ведёт строку — как к врачу обращаются пациенты. null — неизвестно. */
  owner: string | null;
}

const CHILD = /(?<!\p{L})(дет[си]|ребен|ребён|подрост)/iu;
const PREGNANCY = /беремен/iu;

function label(title: string): string {
  if (PREGNANCY.test(title)) return "для беременных";
  return CHILD.test(title.toLowerCase()) ? "детский" : "взрослый";
}

function money(row: OfferRow): string {
  const dur = row.durationMin > 0 ? ` (${row.durationMin} мин)` : "";
  return `${row.price} ₽${dur}`;
}

/** Строка прайса как есть — когда врача у неё нет или подписи не различают строки. */
function plain(row: OfferRow): string {
  const dur = row.durationMin > 0 ? `, ${row.durationMin} мин` : "";
  return `• ${row.title} — ${row.price} ₽${dur}`;
}

export function groupedOffer(
  rows: OfferRow[],
  /**
   * Делится ли услуга на взрослый и детский приём. Только тогда подписи
   * «взрослый / детский» что-то значат: у БОС такого деления нет, и «Омарова
   * Ирина — взрослый приём 2800 ₽» читалось бы так, будто детей она не берёт.
   * По умолчанию — есть ли среди строк и детская, и взрослая.
   */
  ageSplit: boolean = rows.some((r) => CHILD.test(r.title.toLowerCase())) && rows.some((r) => !CHILD.test(r.title.toLowerCase())),
): string {
  const byOwner = new Map<string, OfferRow[]>();
  const loose: OfferRow[] = [];
  for (const row of rows) {
    if (row.owner) byOwner.set(row.owner, [...(byOwner.get(row.owner) ?? []), row]);
    else loose.push(row);
  }
  const lines: string[] = [];
  for (const [owner, own] of byOwner) {
    const labels = own.map((r) => label(r.title));
    /**
     * Подписи «взрослый / детский» годятся, только если различают строки: у
     * БОС «сеанс» и «курс» — обе «взрослые», и подпись спрятала бы, что это
     * разные вещи. Тогда под врачом стоят названия строк.
     */
    if (!ageSplit) {
      lines.push(
        own.length === 1
          ? `• ${owner} — ${own[0].title} ${money(own[0])}`
          : [`• ${owner}:`, ...own.map((r) => `  ${plain(r).slice(2)}`)].join("\n"),
      );
    } else if (new Set(labels).size === labels.length) {
      const sorted = own
        .map((r, i) => ({ r, l: labels[i] }))
        .sort((a, b) => order(a.l) - order(b.l));
      const parts = sorted.map(({ r, l }, i) => (i === 0 ? `${l} приём ${money(r)}` : `${l} ${money(r)}`));
      lines.push(`• ${owner} — ${parts.join(", ")}`);
    } else {
      lines.push(`• ${owner}:`, ...own.map((r) => `  ${plain(r).slice(2)}`));
    }
  }
  lines.push(...loose.map(plain));
  return lines.join("\n");
}

function order(label: string): number {
  return label === "взрослый" ? 0 : label === "детский" ? 1 : 2;
}

/** «два врача», «три врача»: сколько — словами, как сказал бы администратор. */
export function doctorsWord(n: number): string {
  const words: Record<number, string> = { 2: "два врача", 3: "три врача", 4: "четыре врача" };
  return words[n] ?? "врачи";
}

/**
 * Основной вид услуги клиники — по числу ЛЮДЕЙ, а не приёмов: курс из тридцати
 * сеансов — один человек. Вид, к которому ходило больше всего людей, не меньше
 * `share` из всех и строго больше любого другого; иначе основного нет.
 */
export function mainKindOf(visits: { patientId: string; kind: string | null }[], share: number): string | null {
  const people = new Map<string, Set<string>>();
  const everyone = new Set<string>();
  for (const v of visits) {
    everyone.add(v.patientId);
    if (!v.kind) continue;
    if (!people.has(v.kind)) people.set(v.kind, new Set());
    people.get(v.kind)!.add(v.patientId);
  }
  const ranked = [...people.entries()].map(([kind, set]) => [kind, set.size] as const).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top || everyone.size === 0) return null;
  if (second && second[1] === top[1]) return null;
  return top[1] / everyone.size >= share ? top[0] : null;
}
