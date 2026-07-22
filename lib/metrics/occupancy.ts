import type { RoomGap } from "./types";

/**
 * Загрузка кабинета = занятые минуты / рабочие минуты за период.
 *
 * Занятые минуты — объединение интервалов, а не сумма длительностей:
 * наложения (капельница и забор анализов, поставленные на один кабинет)
 * иначе дают загрузку больше 100%.
 *
 * Всё считается в минутах от полуночи локальной зоны клиники — так функции
 * остаются чистыми и не зависят от таймзоны машины, где идут тесты.
 */

export interface Interval {
  startMinute: number;
  endMinute: number;
}

/** Порог, с которого окно становится интересным администратору. */
export const DEFAULT_MIN_GAP_MINUTES = 60;

/** Объединяет пересекающиеся и соприкасающиеся интервалы. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const valid = intervals
    .filter((interval) => interval.endMinute > interval.startMinute)
    .sort((a, b) => a.startMinute - b.startMinute);

  const merged: Interval[] = [];
  for (const interval of valid) {
    const last = merged[merged.length - 1];
    if (last && interval.startMinute <= last.endMinute) {
      last.endMinute = Math.max(last.endMinute, interval.endMinute);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** Обрезает интервалы по рабочему окну кабинета. */
export function clipToWindow(intervals: Interval[], window: Interval): Interval[] {
  return intervals
    .map((interval) => ({
      startMinute: Math.max(interval.startMinute, window.startMinute),
      endMinute: Math.min(interval.endMinute, window.endMinute),
    }))
    .filter((interval) => interval.endMinute > interval.startMinute);
}

/** Занятые минуты внутри рабочего окна. Наложения не удваиваются. */
export function busyMinutes(intervals: Interval[], window: Interval): number {
  return mergeIntervals(clipToWindow(intervals, window)).reduce(
    (sum, interval) => sum + (interval.endMinute - interval.startMinute),
    0,
  );
}

/**
 * Свободные окна не короче порога. Это главное, что нужно администратору:
 * не «загрузка 68%», а «с 14:30 до 16:00 второй кабинет пустой».
 */
export function freeGaps(
  intervals: Interval[],
  window: Interval,
  minGapMinutes: number = DEFAULT_MIN_GAP_MINUTES,
): RoomGap[] {
  const busy = mergeIntervals(clipToWindow(intervals, window));
  const gaps: RoomGap[] = [];

  let cursor = window.startMinute;
  for (const interval of busy) {
    if (interval.startMinute - cursor >= minGapMinutes) {
      gaps.push({
        startMinute: cursor,
        endMinute: interval.startMinute,
        durationMin: interval.startMinute - cursor,
      });
    }
    cursor = Math.max(cursor, interval.endMinute);
  }

  if (window.endMinute - cursor >= minGapMinutes) {
    gaps.push({
      startMinute: cursor,
      endMinute: window.endMinute,
      durationMin: window.endMinute - cursor,
    });
  }

  return gaps;
}

/** Самое длинное свободное окно — влезет ли ещё капельница на 90 минут. */
export function longestGap(intervals: Interval[], window: Interval): number {
  return freeGaps(intervals, window, 1).reduce((max, gap) => Math.max(max, gap.durationMin), 0);
}

export interface DaySchedule {
  /** 1 = понедельник … 7 = воскресенье. */
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface ScheduleException {
  isClosed: boolean;
  startMinute?: number | null;
  endMinute?: number | null;
}

/**
 * Рабочее окно кабинета на конкретный день: регулярное расписание,
 * перекрытое исключением (праздник, санитарный день, укороченный день).
 * null — кабинет в этот день не работает, и в знаменатель он не попадает.
 */
export function workingWindowForDay(
  schedule: DaySchedule | null | undefined,
  exception?: ScheduleException | null,
): Interval | null {
  if (exception) {
    if (exception.isClosed) return null;
    if (exception.startMinute != null && exception.endMinute != null) {
      return exception.endMinute > exception.startMinute
        ? { startMinute: exception.startMinute, endMinute: exception.endMinute }
        : null;
    }
  }

  if (!schedule) return null;
  if (schedule.endMinute <= schedule.startMinute) return null;
  return { startMinute: schedule.startMinute, endMinute: schedule.endMinute };
}

/** Рабочие минуты за период — знаменатель загрузки. */
export function workingMinutes(windows: (Interval | null)[]): number {
  return windows.reduce(
    (sum, window) => sum + (window ? window.endMinute - window.startMinute : 0),
    0,
  );
}

/** Загрузка 0..1. Кабинет, который не работал, загрузку не искажает. */
export function occupancyRate(busy: number, working: number): number {
  if (working <= 0) return 0;
  return Math.min(busy / working, 1);
}

/** `540` → `09:00`. */
export function formatMinute(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
