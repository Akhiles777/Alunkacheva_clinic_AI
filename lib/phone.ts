/**
 * Нормализация телефона в E.164.
 *
 * Матчинг пациентов идёт по телефону, поэтому номер приводится к канону
 * на входе — в вебхуке, в импорте, в форме. Ниже по коду телефон всегда
 * уже нормализован.
 *
 * Уникальности по номеру нет: один номер бывает у семьи (дети записаны на
 * телефон родителя), поэтому нормализация не «схлопывает» пациентов сама —
 * она только даёт стабильный ключ поиска.
 */

const RU_NATIONAL_LENGTH = 10;
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

/**
 * Возвращает номер в формате E.164 (`+79991234567`) либо null, если строка
 * на телефон не похожа. Российские номера восстанавливаются из привычных
 * записей: `8 (999) 123-45-67`, `9991234567`, `7 999 123 45 67`.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;

  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (!hasPlus) {
    // 00 — международный префикс в европейской записи.
    if (digits.startsWith("00")) {
      digits = digits.slice(2);
    } else if (digits.length === RU_NATIONAL_LENGTH + 1 && digits.startsWith("8")) {
      digits = `7${digits.slice(1)}`;
    } else if (digits.length === RU_NATIONAL_LENGTH && digits.startsWith("9")) {
      digits = `7${digits}`;
    }
  }

  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null;
  if (digits.startsWith("0")) return null;

  // Российский номер: 7 + 10 цифр, мобильные и городские не путаем — просто
  // проверяем длину, потому что 8-800 тоже валидный номер клиники.
  if (digits.startsWith("7") && digits.length !== 11) return null;

  return `+${digits}`;
}

/** Формат для интерфейса: `+7 999 123-45-67`. Не для хранения. */
export function formatPhone(e164: string): string {
  const match = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(e164);
  if (!match) return e164;
  return `+7 ${match[1]} ${match[2]}-${match[3]}-${match[4]}`;
}

/** Одинаковый ли это номер. Обе стороны нормализуются. */
export function isSamePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  return left !== null && left === right;
}
