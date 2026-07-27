/**
 * Откуда берётся кабинет визита.
 *
 * Открытый вопрос к клинике: заведены ли три кабинета в YCLIENTS как
 * ресурсы. Ответ меняет только источник данных, но не экран — поэтому он
 * за флагом, а не в разметке.
 *
 *   ROOMS_FROM_RESOURCES=true   кабинет читаем из ресурса записи YCLIENTS
 *   ROOMS_FROM_RESOURCES=false  кабинет выводим из Staff.defaultRoomId
 *
 * По умолчанию false: маппинг работает без ответа клиента, потому что
 * «специалист → кабинет» клиника знает и так.
 */

export type RoomSource = "yclients-resource" | "staff-mapping";

export function roomSource(): RoomSource {
  return process.env.ROOMS_FROM_RESOURCES === "true"
    ? "yclients-resource"
    : "staff-mapping";
}

/** Человекочитаемо — для служебной строки и отладки синхронизации. */
export const ROOM_SOURCE_LABEL: Record<RoomSource, string> = {
  "yclients-resource": "ресурсы YCLIENTS",
  "staff-mapping": "маппинг «специалист → кабинет»",
};

export interface RoomResolutionInput {
  /** Ресурс из записи YCLIENTS, если кабинеты там ведутся. */
  yclientsResourceRoomId?: string | null;
  /** Кабинет специалиста из справочника — запасной источник. */
  staffDefaultRoomId?: string | null;
}

/**
 * Кабинет визита по действующему источнику. Возвращает null, когда кабинет
 * определить нечем: визит попадает в расписание, но не в загрузку кабинета —
 * молча приписывать его первому попавшемуся кабинету нельзя, иначе метрика
 * загрузки начнёт врать.
 */
export function resolveRoomId(
  input: RoomResolutionInput,
  source: RoomSource = roomSource(),
): string | null {
  if (source === "yclients-resource") {
    return input.yclientsResourceRoomId ?? null;
  }
  return input.staffDefaultRoomId ?? null;
}
