import { describe, expect, it } from "vitest";
import { periodBounds } from "./analytics";

/**
 * «Неделя» обязана означать один и тот же отрезок в отчётах и на графике
 * владельца. Пока отчёт брал последние семь дней до сегодня, а график — полные
 * календарные недели, под одним словом стояли 205 тысяч и 215.
 */
const MONDAY_17 = new Date("2026-08-17T14:00:00+03:00");

describe("границы периода", () => {
  it("«Неделя» — последняя полная календарная неделя", () => {
    const { from, to } = periodBounds("week", MONDAY_17);
    // Понедельник 10 августа 00:00 по клинике — воскресенье 16-е включительно.
    expect(from.toISOString()).toBe("2026-08-09T21:00:00.000Z");
    expect(to.toISOString()).toBe("2026-08-16T21:00:00.000Z");
  });

  it("«Неделя» совпадает с ключом недели того же отрезка", () => {
    const rolling = periodBounds("week", MONDAY_17);
    const calendar = periodBounds("w2026-08-10", MONDAY_17);
    expect(rolling).toEqual(calendar);
  });

  it("месяц — ровно тридцать суток клиники, а не тридцать с хвостом", () => {
    const { from, to } = periodBounds("month", MONDAY_17);
    // Начало — полночь клиники, конец — конец сегодняшних суток.
    expect(from.toISOString()).toBe("2026-07-18T21:00:00.000Z");
    expect(to.toISOString()).toBe("2026-08-17T20:59:59.999Z");
    const days = Math.round((to.getTime() - from.getTime()) / (24 * 3600 * 1000));
    expect(days).toBe(30);
  });

  it("календарный месяц берётся целиком", () => {
    const { from, to } = periodBounds("2026-05", MONDAY_17);
    expect(from.toISOString()).toBe("2026-04-30T21:00:00.000Z");
    expect(to.toISOString()).toBe("2026-05-31T21:00:00.000Z");
  });
});
