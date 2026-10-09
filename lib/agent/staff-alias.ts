/**
 * Фамилия врача, которой нет в YCLIENTS, но которую знают пациенты.
 *
 * Снимок боевых данных 9 октября: в YCLIENTS врач заведена как «Ирина
 * Алилгаджиевна» — без фамилии, — а пациенты пишут «к Ирине Алункачевой». Ирин
 * в клинике две, и по одному имени врач не определялся: агент отвечал «по имени
 * Ирина Алункачева у меня данных нет, хочу убедиться…», не спрашивал согласия и
 * не принимал анкету. В песочнице, где фамилия была, всё работало.
 *
 * Полное имя клиника сама пишет в справочнике: «Алункачева Ирина
 * Алилгаджиевна». Отсюда и берём фамилию — только в таком виде, слово с
 * заглавной прямо перед полным именем из YCLIENTS. Правила разговора получают
 * слова пациента с подсказкой: «к Ирине Алункачевой» → «к Ирине Алункачевой
 * (Ирина Алилгаджиевна)». Сообщение в базе не меняется — подсказка только для
 * разбора.
 */

export interface StaffAlias {
  /** Основа фамилии: «алункачев» — найдёт «Алункачевой», «Алункачева». */
  stem: string;
  /** Имя сотрудника, как в YCLIENTS: его и подставляем рядом. */
  name: string;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

export function aliasesFromKnowledge(answers: string[], staffNames: string[]): StaffAlias[] {
  const out: StaffAlias[] = [];
  for (const name of staffNames) {
    const parts = name.trim().split(/\s+/);
    // Нужны имя и отчество: по одному слову фамилию к человеку не привязать.
    if (parts.length !== 2) continue;
    const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const re = new RegExp(`(\\p{Lu}\\p{Ll}{3,})\\s+${escaped}(?!\\p{L})`, "u");
    const found = new Set<string>();
    for (const a of answers) {
      const m = re.exec(a);
      if (m) found.add(norm(m[1]));
    }
    // Разные «фамилии» перед одним именем — не фамилия, а случайное слово.
    if (found.size !== 1) continue;
    const surname = [...found][0];
    if (staffNames.some((n) => norm(n).split(/\s+/).includes(surname))) continue;
    out.push({ stem: surname.slice(0, Math.max(5, surname.length - 1)), name });
  }
  return out;
}

/**
 * Подсказка рядом с фамилией: «к Ирине Алункачевой (Ирина Алилгаджиевна)».
 * Сотрудник уже назван полностью — текст не трогаем.
 */
export function withStaffAliases(text: string, aliases: StaffAlias[]): string {
  let out = text;
  for (const a of aliases) {
    const re = new RegExp(`(?<!\\p{L})(${a.stem}\\p{L}*)`, "iu");
    if (!re.test(norm(out))) continue;
    const patronymic = norm(a.name.split(/\s+/)[1] ?? "");
    if (patronymic && norm(out).includes(patronymic.slice(0, 6))) continue;
    out = out.replace(new RegExp(`(?<!\\p{L})(${a.stem}\\p{L}*)`, "iu"), `$1 (${a.name})`);
  }
  return out;
}
