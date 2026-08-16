import type { Turn } from "./llm";

/**
 * Три неудачные попытки понять запрос — человеку (§6, триггеры эскалации).
 *
 * Правило было записано в требованиях и не реализовано нигде: на прогоне
 * сценариев пациент трижды написал невнятное («ыыы», «?», «ну так что»), и
 * агент трижды бодро переспросил, чем может помочь. Человека не позвал никто.
 * Для клиники это потерянное обращение: живой администратор на третьей реплике
 * уже понял бы, что проще ответить голосом.
 *
 * Считаем по сообщениям пациента, а не по своим переспрашиваниям. Первая
 * версия смотрела на формулировки агента и промахивалась дважды: она не узнала
 * «помогите мне понять, что вам нужно» и была готова оборвать нормальный
 * разговор о записи, где два уточняющих вопроса подряд — это норма
 * («для взрослого или ребёнка?», «к какому врачу?»).
 */

/**
 * Сообщение, из которого нельзя понять запрос.
 *
 * Признак — отсутствие содержательного слова: ни числа, ни слова длиннее трёх
 * букв. «ыыы», «?», «ну так что» подходят; «Взрослому» — нет, это ответ по
 * делу, даже если он короткий.
 */
export function uninformative(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/\d/.test(t)) return false;
  const words = t.split(/[^\p{L}]+/u).filter(Boolean);
  return !words.some((w) => w.length > 3);
}

/** Сколько невнятных сообщений пациента подряд в конце разговора. */
export function confusedStreak(history: Turn[], current?: string): number {
  const patientTurns = history.filter((t) => t.role === "user").map((t) => t.content);
  if (current !== undefined) patientTurns.push(current);

  let streak = 0;
  for (let i = patientTurns.length - 1; i >= 0; i -= 1) {
    if (!uninformative(patientTurns[i])) break;
    streak += 1;
  }
  return streak;
}

/** Пора звать человека: три попытки подряд ни к чему не привели (§6). */
export function stuckInMisunderstanding(history: Turn[], current?: string): boolean {
  return confusedStreak(history, current) >= 3;
}
