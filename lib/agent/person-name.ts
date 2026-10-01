/**
 * Как обращаться к человеку по имени из мессенджера.
 *
 * Имя контакта в WhatsApp — то, что человек написал сам себе в профиле, и
 * часто это не имя: «amikomiko», «zarema_1985», «Мама Амины», «🌸». Живой
 * диалог 1 октября: «Спасибо за информацию, amikomiko 🌿» — так обращается
 * автоответчик, а не клиника. Имя из карточки пациента (оно приходит из
 * YCLIENTS) надёжно; имя контакта берём, только если оно похоже на имя
 * человека: одно-три слова с заглавной буквы, без цифр и подчёркиваний.
 * Не похоже — лучше не обращаться по имени вовсе.
 */
const NOT_A_NAME = new Set([
  "мама",
  "папа",
  "бабушка",
  "дедушка",
  "клиника",
  "салон",
  "магазин",
  "доктор",
  "врач",
  "администратор",
  "мамочка",
  "любимая",
  "любимый",
]);

export function addressableName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/[\d_@]/.test(raw)) return null;
  const cleaned = raw
    .replace(/[^\p{L}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(" ");
  if (words.length > 3) return null;
  const nameLike = (w: string) => w.length >= 2 && w.length <= 20 && /^\p{Lu}\p{Ll}+(?:-\p{Lu}?\p{Ll}+)?$/u.test(w);
  if (!words.every(nameLike)) return null;
  if (words.some((w) => NOT_A_NAME.has(w.toLowerCase()))) return null;
  return cleaned;
}
