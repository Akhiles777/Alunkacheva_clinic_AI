/**
 * Слить ответ сервера с тем, что человек видит на экране, не меняя порядок.
 *
 * Раздел базы знаний после сохранения заменял список целиком тем, что вернул
 * сервер, — а сервер отдаёт записи по алфавиту. Строка, добавленная в конец,
 * уезжала в середину шести десятков других, и человек считал, что она
 * потерялась и не сохранилась.
 *
 * Порядок на экране принадлежит человеку: он добавил запись в конец — там она
 * и должна остаться. Сервер решает содержимое и идентификаторы, а не порядок.
 */
export function mergeKeepingOrder<T>(
  current: T[],
  saved: T[],
  keyOf: (item: T) => string,
): T[] {
  const byKey = new Map<string, T>();
  for (const item of saved) byKey.set(keyOf(item), item);

  const used = new Set<string>();
  const merged = current.map((item) => {
    const key = keyOf(item);
    const match = byKey.get(key);
    if (!match) return item;
    used.add(key);
    return match;
  });

  /**
   * Записи, которых на экране не было, дописываем в конец. Это то, что завёл
   * кто-то другой: потерять их нельзя, но и вклинивать в середину чужого
   * списка незачем.
   */
  for (const item of saved) {
    if (!used.has(keyOf(item))) merged.push(item);
  }
  return merged;
}
