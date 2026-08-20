/**
 * Часть справки про того, о ком спросили.
 *
 * Записи справочника покрывают несколько случаев сразу: «остеопатия» — это оба
 * врача, четыре цены и общее примечание. Когда модель недоступна, агент
 * отправляет запись дословно — и на вопрос «сколько стоит у Ирины
 * Алункачевой» пациент получает весь блок про двоих. Формально верно, а по
 * сути ответ не на его вопрос.
 *
 * Здесь запись режется по людям: остаётся вступление, блок названного врача и
 * общий хвост, который никого не называет. Ничего не добавляем и не
 * переписываем — только убираем чужие абзацы, поэтому правило «медицинские
 * темы отвечаются дословно» не нарушается: сказанное остаётся словами клиники.
 */

/**
 * Имя человека в строке.
 *
 * Сравниваем по словам, а не по вхождению подстроки: «Гаджиевна» находится
 * внутри «Алилгаджиевны», и Сафия Гаджиевна оказывалась упомянутой в блоке
 * Ирины Алилгаджиевны. Из-за этого блок резался не там.
 */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^а-яa-z0-9]+/i)
    .filter((w) => w.length >= 4);
}

function mentions(line: string, name: string): boolean {
  const parts = wordsOf(name);
  if (parts.length === 0) return false;
  const inLine = new Set(wordsOf(line));
  return parts.some((p) => inLine.has(p));
}

export function focusedAnswer(
  answer: string,
  /** О ком спросили. Пусто — режем нечего. */
  person: string | null,
  /** Все, кто принимает: по ним видно, где начинается чужой блок. */
  everyone: string[],
): string {
  if (!person) return answer;
  const lines = answer.split("\n");
  const others = everyone.filter((n) => !mentions(n, person));
  if (others.length === 0) return answer;

  const owner = (line: string): "asked" | "other" | null => {
    if (mentions(line, person)) return "asked";
    return others.some((n) => mentions(line, n)) ? "other" : null;
  };

  // Ни названного, ни чужих — резать нечего, запись и так про одно.
  if (!lines.some((l) => owner(l) === "asked")) return answer;
  if (!lines.some((l) => owner(l) === "other")) return answer;

  const kept: string[] = [];
  /** null — общий текст: вступление до первого имени и хвост после блоков. */
  let current: "asked" | "other" | null = null;
  for (const line of lines) {
    /**
     * Пустая строка закрывает блок.
     *
     * У клиники запись устроена абзацами: имя врача и под ним его цены, между
     * врачами — пустая строка, а в конце общее примечание. Без сброса это
     * примечание считалось продолжением последнего врача и терялось, хотя оно
     * относится ко всем.
     */
    if (line.trim().length === 0) {
      current = null;
      kept.push(line);
      continue;
    }
    const who = owner(line);
    if (who !== null) current = who;
    if (current === "other") continue;
    kept.push(line);
  }

  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // Осталось одно вступление — лучше отдать запись целиком, чем огрызок.
  return text.length >= 40 ? text : answer;
}
