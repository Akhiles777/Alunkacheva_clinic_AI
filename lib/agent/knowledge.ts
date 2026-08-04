/**
 * Подбор ответа из справочника клиники.
 *
 * Ассистент отвечает на медицинские темы (подготовка, противопоказания,
 * условия приёма) только тем текстом, который клиника завела и утвердила сама
 * — дословно. Модель не сочиняет и не «дополняет по смыслу»: её роль здесь
 * ограничена подбором подходящей записи. Нет записи — вопрос уходит человеку.
 *
 * Это компромисс, о котором договорились с заказчиком: он хочет, чтобы бот
 * отвечал про подготовку и противопоказания, но выдумывать такое нельзя.
 */

export interface KnowledgeRow {
  topic: string;
  question: string;
  answer: string;
}

/** Слова длиннее двух букв, в нижнем регистре, без пунктуации. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Простая нормализация окончаний: «противопоказания» ≈ «противопоказаний». */
function stem(word: string): string {
  return word.length > 5 ? word.slice(0, word.length - 2) : word;
}

/**
 * Лучшая запись справочника для вопроса и её оценка (0..1).
 * Оценка — доля слов вопроса, нашедшихся в записи.
 */
export function matchKnowledge(
  question: string,
  rows: KnowledgeRow[],
): { row: KnowledgeRow; score: number } | null {
  const asked = words(question).map(stem);
  if (asked.length === 0 || rows.length === 0) return null;

  let best: { row: KnowledgeRow; score: number } | null = null;
  for (const row of rows) {
    const haystack = new Set(words(`${row.topic} ${row.question} ${row.answer}`).map(stem));
    const hits = asked.filter((w) => haystack.has(w)).length;
    const score = hits / asked.length;
    if (!best || score > best.score) best = { row, score };
  }
  return best;
}

/** Порог уверенности: ниже него отвечать нельзя, вопрос уходит человеку. */
export const KNOWLEDGE_MIN_SCORE = 0.34;
