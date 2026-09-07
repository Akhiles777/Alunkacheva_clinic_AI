/**
 * Дни приёма врачей — то, что клиника знает, а агент до сих пор не знал.
 *
 * Живой диалог: «Здравствуйте, подскажите, работаете ли вы в выходные дни? И
 * сколько у вас стоит приём?» Агент ответил верно про клинику («в субботу с
 * 09:00 до 21:00») и назвал цены ОБОИХ остеопатов — а в субботу принимает
 * только одна из них. Администратору пришлось писать вслед: «в субботу
 * принимает Разият Ризвановна».
 *
 * График клиники и график врача — разные вещи, и путать их дороже всего в
 * ответе на прямой вопрос: человек запоминает имя и приезжает не в тот день.
 */

/** 1 = понедельник … 7 = воскресенье (ISO-8601), как в ClinicSchedule. */
export const WEEKDAY_NAMES: Record<number, string> = {
  1: "понедельник",
  2: "вторник",
  3: "среда",
  4: "четверг",
  5: "пятница",
  6: "суббота",
  7: "воскресенье",
};

/**
 * «В субботу», а не «в суббота».
 *
 * Мелочь, которая читается как машинный перевод: пациент видит «В пятница
 * принимает…» и понимает, что говорит с программой. Предлог тоже разный —
 * «во вторник».
 */
export const WEEKDAY_WHEN: Record<number, string> = {
  1: "в понедельник",
  2: "во вторник",
  3: "в среду",
  4: "в четверг",
  5: "в пятницу",
  6: "в субботу",
  7: "в воскресенье",
};

const WEEKDAY_WORDS: { day: number; re: RegExp }[] = [
  { day: 1, re: /(?<!\p{L})понедельник\p{L}*(?!\p{L})/iu },
  { day: 2, re: /(?<!\p{L})вторник\p{L}*(?!\p{L})/iu },
  { day: 3, re: /(?<!\p{L})сред[ауые]\p{L}*(?!\p{L})/iu },
  { day: 4, re: /(?<!\p{L})четверг\p{L}*(?!\p{L})/iu },
  { day: 5, re: /(?<!\p{L})пятниц\p{L}*(?!\p{L})/iu },
  { day: 6, re: /(?<!\p{L})суббот\p{L}*(?!\p{L})/iu },
  { day: 7, re: /(?<!\p{L})воскресень\p{L}*|воскресен\p{L}*(?!\p{L})/iu },
];

/**
 * Дни недели, названные в вопросе.
 *
 * «Выходные» — это суббота и воскресенье: так говорят люди, и именно так был
 * задан вопрос, с которого всё началось.
 */
export function daysAsked(text: string): number[] {
  const found = new Set<number>();
  for (const { day, re } of WEEKDAY_WORDS) if (re.test(text)) found.add(day);
  if (/(?<!\p{L})выходн\p{L}*(?!\p{L})/iu.test(text)) {
    found.add(6);
    found.add(7);
  }
  return [...found].sort((a, b) => a - b);
}

export interface StaffDays {
  name: string;
  specialty?: string | null;
  /** Пустой список — дни не заданы: об этом враче в такой ответ не идём. */
  workdays: number[];
}

/**
 * Кто принимает в названные дни.
 *
 * Врачи без заданных дней в ответ не попадают ни в одну сторону: пустая
 * настройка не значит «не работает», и утверждать за неё нельзя.
 */
export function whoWorks(staff: StaffDays[], days: number[]): { works: StaffDays[]; off: StaffDays[] } {
  const known = staff.filter((s) => s.workdays.length > 0);
  return {
    works: known.filter((s) => days.some((d) => s.workdays.includes(d))),
    off: known.filter((s) => !days.some((d) => s.workdays.includes(d))),
  };
}

/** Названный в вопросе врач — по первым буквам имени, чтобы падежи не мешали. */
export function staffAsked<T extends { name: string }>(text: string, staff: T[]): T | null {
  const norm = text.toLowerCase().replace(/ё/g, "е");
  return (
    staff.find((s) =>
      s.name
        .toLowerCase()
        .replace(/ё/g, "е")
        .split(/\s+/)
        .filter((w) => w.length >= 4)
        .some((w) => norm.includes(w.slice(0, 5))),
    ) ?? null
  );
}
