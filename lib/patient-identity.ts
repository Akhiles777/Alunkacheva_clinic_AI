import { normalizePhone } from "./phone";

/**
 * Сопоставление пациента при выгрузке из YCLIENTS.
 *
 * По §4 телефон — единственный надёжный ключ: имена совпадают у разных людей,
 * а идентификатор YCLIENTS есть только у тех, кто заведён там. Порядок поиска
 * решает судьбу истории визитов, поэтому вынесен в чистую функцию и покрыт
 * тестами: ошибка здесь молча разъезжает карточки пациентов, и заметно это
 * становится через месяцы.
 */

export interface MatchInput {
  /** Идентификатор клиента в YCLIENTS, если он есть. */
  yclientsId: number | null;
  /** Телефон в любом написании — нормализуем сами. */
  phone: string | null;
}

export interface KnownPatient {
  id: string;
  yclientsId: number | null;
  phones: string[];
}

export type MatchResult =
  | { kind: "by-yclients-id"; patientId: string }
  | { kind: "by-phone"; patientId: string }
  | { kind: "new" };

/**
 * Кого считать тем же пациентом.
 *
 * Сначала идентификатор YCLIENTS — он точен по определению. Затем телефон:
 * так находится человек, заведённый клиникой вручную до интеграции. Иначе
 * выгрузка завела бы ему вторую карточку, и визиты распределялись бы между
 * двумя произвольно.
 */
export function matchPatient(input: MatchInput, known: KnownPatient[]): MatchResult {
  if (input.yclientsId !== null) {
    const byId = known.find((p) => p.yclientsId === input.yclientsId);
    if (byId) return { kind: "by-yclients-id", patientId: byId.id };
  }

  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (phone) {
    const byPhone = known.find((p) => p.phones.some((x) => normalizePhone(x) === phone));
    if (byPhone) return { kind: "by-phone", patientId: byPhone.id };
  }

  return { kind: "new" };
}
