import type { Turn } from "./llm";

/**
 * Повторы в диалоге.
 *
 * Справочник отвечает дословно — это правило (§6.1), и для медицинских тем оно
 * не обсуждается. Но у него есть побочный эффект: на второй похожий вопрос
 * пациент получает ровно тот же блок текста, слово в слово. Со стороны это
 * выглядит как заевшая пластинка — «бот тупой, повторяется».
 *
 * Здесь — распознавание такого случая. Что с ним делать, решает агент: для
 * организационного вопроса он передаёт найденную запись модели, чтобы та
 * ответила связно; для медицинского повторяет дословно, потому что иначе
 * нельзя.
 */

/** Насколько две реплики считаются одним и тем же. */
const SAME_THRESHOLD = 0.9;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Уже говорили это в диалоге?
 *
 * Сравниваем с ответами бота, а не со всей перепиской: повтор за пациентом —
 * нормальная вежливость, повтор за собой — заедание.
 */
export function alreadySaid(history: Turn[], candidate: string): boolean {
  const target = normalize(candidate);
  if (target.length < 40) return false; // короткие подтверждения повторять нормально

  return history
    .filter((t) => t.role === "assistant")
    .some((t) => similar(normalize(t.content), target));
}

/**
 * Похожесть по общим словам. Точного совпадения мало: справочная запись могла
 * уйти с приставкой вроде подсказки про специалиста, и строки уже не равны, а
 * пациент видит тот же текст.
 */
function similar(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const wa = new Set(a.split(" ").filter((w) => w.length > 3));
  const wb = new Set(b.split(" ").filter((w) => w.length > 3));
  if (wa.size === 0 || wb.size === 0) return false;

  let common = 0;
  for (const w of wb) if (wa.has(w)) common += 1;
  return common / Math.max(wa.size, wb.size) >= SAME_THRESHOLD;
}

/**
 * Здоровались ли уже.
 *
 * Приветствие в середине разговора — самый заметный признак того, что
 * собеседник не помнит предыдущих реплик.
 */
export function alreadyGreeted(history: Turn[]): boolean {
  return history.some((t) => t.role === "assistant");
}
