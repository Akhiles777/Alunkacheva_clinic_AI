/**
 * Кого можно поставить в свободное окно.
 *
 * Окна видны как факт, список «кому позвонить» — тоже; между ними администратор
 * каждый раз ходит головой: «а Магомедовой сюда влезет?». Здесь эта проверка
 * записана правилами, и каждое из них — отдельная причина НЕ показать
 * кандидата. Пустой список честнее предложения, которое сорвётся: позвонить и
 * получить «нет, не получится» хуже, чем не звонить.
 *
 * Ничего не бронируем и не резервируем: система показывает, кому позвонить,
 * записывает администратор.
 */

export interface WindowSlot {
  /** Начало окна — минуты от начала суток клиники. */
  startMinute: number;
  durationMin: number;
  roomId: string;
  /** День окна. Нужен, чтобы отличить прошлое от будущего. */
  date: Date;
}

export interface CandidateInput {
  patientId: string;
  patientName: string;
  /** Почему он в очереди — то же основание, что на экране «Кому позвонить». */
  basis: string;
  /** Услуга, ради которой звоним. Без неё длительность не проверить. */
  serviceId: string | null;
  serviceTitle: string | null;
  serviceDurationMin: number | null;
  /** Кабинеты, где услуга проводится. Пусто — ограничений нет. */
  serviceRoomIds: string[];
  /** Специалисты услуги и их занятость в это время. */
  staffAvailable: boolean | null;
  /** Есть ли куда написать. */
  reachable: boolean;
  /** Пересекается ли своей записью с этим окном. */
  busyAtWindow: boolean;
  money: number | null;
}

export type RejectReason =
  | "long"
  | "room"
  | "staff"
  | "unreachable"
  | "busy"
  | "unknownService";

export interface FitResult {
  ok: boolean;
  reason?: RejectReason;
}

/**
 * Проверки идут по одной и в порядке, в котором о них думает человек:
 * влезет ли по времени, можно ли в этом кабинете, есть ли кому вести, можно
 * ли дозвониться, свободен ли сам пациент.
 */
export function fitsWindow(c: CandidateInput, slot: WindowSlot): FitResult {
  if (c.serviceId === null || c.serviceDurationMin === null) {
    // Не знаем, что предлагать, — значит и предлагать нечего.
    return { ok: false, reason: "unknownService" };
  }
  if (c.serviceDurationMin > slot.durationMin) return { ok: false, reason: "long" };
  if (c.serviceRoomIds.length > 0 && !c.serviceRoomIds.includes(slot.roomId)) {
    return { ok: false, reason: "room" };
  }
  if (c.staffAvailable === false) return { ok: false, reason: "staff" };
  if (!c.reachable) return { ok: false, reason: "unreachable" };
  if (c.busyAtWindow) return { ok: false, reason: "busy" };
  return { ok: true };
}

/** Окно в прошлом кандидатов не имеет: предлагать туда нечего. */
export function windowIsPast(slot: WindowSlot, now: Date = new Date()): boolean {
  const start = new Date(slot.date);
  start.setHours(0, 0, 0, 0);
  return start.getTime() + slot.startMinute * 60_000 <= now.getTime();
}

/** Сколько минут осталось до окна. Нужно, чтобы честно сказать «времени мало». */
export function minutesUntil(slot: WindowSlot, now: Date = new Date()): number {
  const start = new Date(slot.date);
  start.setHours(0, 0, 0, 0);
  return Math.round((start.getTime() + slot.startMinute * 60_000 - now.getTime()) / 60_000);
}

/** Меньше этого времени до окна — предупреждаем: договориться могут не успеть. */
export const TIGHT_MINUTES = 90;
