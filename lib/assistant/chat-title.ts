/**
 * Заголовок сохранённого разбора.
 *
 * Первый вопрос владельца и есть название чата: «где мы теряем деньги»
 * говорит о разговоре больше, чем «Разбор 3». Длинный вопрос обрезаем по
 * слову — обрыв на середине слова в списке читается как поломка.
 */
const MAX = 40;

export function titleFrom(question: string): string {
  const clean = question.trim().replace(/\s+/g, " ");
  if (clean.length === 0) return "Новый разбор";
  if (clean.length <= MAX) return clean;
  const cut = clean.slice(0, MAX);
  const space = cut.lastIndexOf(" ");
  // Пробел у самого начала не считаем: «Где…» хуже, чем обрезка по букве.
  return `${(space > MAX / 2 ? cut.slice(0, space) : cut).trim()}…`;
}
