import { describe, expect, it } from "vitest";
import { DEFAULT_QUIET, inQuietHours, shouldPushNow } from "./notify-window";

/** Московское время в виде UTC-даты: MSK = UTC+3. */
const msk = (day: number, hour: number) => new Date(Date.UTC(2026, 7, day, hour - 3, 0));

describe("inQuietHours", () => {
  it("окно через полночь захватывает и вечер, и утро", () => {
    expect(inQuietHours(23 * 60, 22 * 60, 8 * 60)).toBe(true);
    expect(inQuietHours(2 * 60, 22 * 60, 8 * 60)).toBe(true);
    expect(inQuietHours(12 * 60, 22 * 60, 8 * 60)).toBe(false);
  });

  it("границы: начало включительно, конец исключительно", () => {
    expect(inQuietHours(22 * 60, 22 * 60, 8 * 60)).toBe(true);
    expect(inQuietHours(8 * 60, 22 * 60, 8 * 60)).toBe(false);
  });

  it("одинаковые границы означают отсутствие тихих часов", () => {
    expect(inQuietHours(3 * 60, 9 * 60, 9 * 60)).toBe(false);
  });
});

describe("shouldPushNow", () => {
  // 9 августа 2026 — воскресенье, 10 августа — понедельник.
  const sunday = msk(9, 12);
  const mondayDay = msk(10, 12);
  const mondayNight = msk(10, 23);

  it("в воскресенье обычное уведомление копится", () => {
    expect(shouldPushNow({ kind: "CHAT_MESSAGE", at: sunday, settings: DEFAULT_QUIET })).toBe(false);
  });

  it("в понедельник днём уходит сразу", () => {
    expect(shouldPushNow({ kind: "CHAT_MESSAGE", at: mondayDay, settings: DEFAULT_QUIET })).toBe(true);
  });

  it("ночью обычное уведомление ждёт утра", () => {
    expect(shouldPushNow({ kind: "BOOKING", at: mondayNight, settings: DEFAULT_QUIET })).toBe(false);
  });

  it("эскалация будит всегда — и ночью, и в воскресенье", () => {
    expect(shouldPushNow({ kind: "ESCALATION", at: sunday, settings: DEFAULT_QUIET })).toBe(true);
    expect(shouldPushNow({ kind: "ESCALATION", at: mondayNight, settings: DEFAULT_QUIET })).toBe(true);
  });

  it("сообщение пациента тоже срочное", () => {
    expect(shouldPushNow({ kind: "PATIENT_MESSAGE", at: sunday, settings: DEFAULT_QUIET })).toBe(true);
  });
});
