import type { NotificationKind } from "@/generated/prisma/enums";

/**
 * Когда push уходит сразу, а когда ждёт начала смены.
 *
 * Заказчик: «в воскресенье пусть копятся до начала смены, то есть до
 * понедельника», но срочное администратор хочет видеть сразу — новый пациент
 * на свободное окно или отмена не должны лежать до утра.
 *
 * Уведомление никуда не пропадает: оно всегда создаётся и лежит в
 * колокольчике. Откладывается только звук на телефоне.
 */

/** Поводы, которые будят всегда: их цена — потерянный пациент или конфликт. */
const ALWAYS_PUSH: NotificationKind[] = ["ESCALATION", "PATIENT_MESSAGE"];

export interface QuietSettings {
  /** Дни недели (1=Пн … 7=Вс), когда push копится до следующей смены. */
  batchWeekdays: number[];
  /** Начало тихих часов, минут от полуночи. */
  quietFrom: number;
  /** Конец тихих часов, минут от полуночи. */
  quietTo: number;
}

export const DEFAULT_QUIET: QuietSettings = {
  batchWeekdays: [7],
  quietFrom: 22 * 60,
  quietTo: 8 * 60,
};

function weekdayInTz(at: Date, tz: string): number {
  const name = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(at);
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[name] ?? 1;
}

function minuteInTz(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** Тихие часы могут пересекать полночь (22:00–08:00) — учитываем оба случая. */
export function inQuietHours(minute: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/**
 * Отправлять ли push прямо сейчас. Срочное — всегда; в выходной день и в тихие
 * часы остальное ждёт смены.
 */
export function shouldPushNow(input: {
  kind: NotificationKind;
  at: Date;
  settings: QuietSettings;
  timezone?: string;
}): boolean {
  if (ALWAYS_PUSH.includes(input.kind)) return true;
  const tz = input.timezone ?? "Europe/Moscow";
  if (input.settings.batchWeekdays.includes(weekdayInTz(input.at, tz))) return false;
  return !inQuietHours(minuteInTz(input.at, tz), input.settings.quietFrom, input.settings.quietTo);
}
