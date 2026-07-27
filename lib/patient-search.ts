/**
 * Поиск пациента по нескольким телефонам и имени, и инвариант «ровно один
 * основной номер». Один пациент — несколько номеров (WhatsApp и звонки на
 * разных), поиск идёт по всем (§3.1).
 */
import { normalizePhone } from "./phone";

export interface PhoneLike {
  phone: string;
  isPrimary?: boolean;
}

export interface PatientLike {
  id: string;
  name?: string | null;
  phones: PhoneLike[];
}

/** Только цифры — для сравнения телефонов независимо от формата записи. */
function digits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Совпадает ли пациент с запросом. Запрос — имя (подстрока, регистронезависимо)
 * или телефон (по цифрам, совпадение по любому из номеров, минимум 3 цифры).
 */
export function patientMatches(patient: PatientLike, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  if (patient.name && patient.name.toLowerCase().includes(q)) return true;

  const qDigits = digits(q);
  if (qDigits.length >= 3) {
    // Нормализуем и запрос, и номера — «8 999…» и «+7 999…» это один номер.
    const normalizedQuery = normalizePhone(query);
    const queryDigits = normalizedQuery ? digits(normalizedQuery) : qDigits;
    return patient.phones.some((p) => {
      const normalized = normalizePhone(p.phone);
      const target = normalized ? digits(normalized) : digits(p.phone);
      return target.includes(queryDigits) || target.includes(qDigits);
    });
  }

  return false;
}

/** Поиск по списку пациентов. Пустой запрос возвращает всех. */
export function searchPatientsByAnyPhone<T extends PatientLike>(patients: T[], query: string): T[] {
  return patients.filter((p) => patientMatches(p, query));
}

/** Ровно один основной номер на пациента. Инвариант из §3.1. */
export function validateSinglePrimary(phones: PhoneLike[]): boolean {
  return phones.filter((p) => p.isPrimary).length === 1;
}

/** Основной номер пациента, если он определён однозначно. */
export function primaryPhone(phones: PhoneLike[]): string | null {
  const primaries = phones.filter((p) => p.isPrimary);
  return primaries.length === 1 ? primaries[0].phone : null;
}
