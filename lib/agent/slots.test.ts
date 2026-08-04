import { describe, expect, it } from "vitest";
import { freeWindows, overlaps, type Busy } from "./slots";

/**
 * Выбор слотов — та логика, где ошибка стоит дороже всего: двойная запись в
 * одно окно. Проверяем именно границы, а не «в целом работает».
 */

const D = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 10, h, m));

describe("overlaps", () => {
  it("пересечение считается по строгому неравенству", () => {
    // Визит 10:00–11:00 и визит 11:00–12:00 идут встык — это не конфликт.
    expect(overlaps(D(10), D(11), D(11), D(12))).toBe(false);
    expect(overlaps(D(11), D(12), D(10), D(11))).toBe(false);
  });

  it("наложение на минуту — уже конфликт", () => {
    expect(overlaps(D(10), D(11), D(10, 59), D(12))).toBe(true);
  });

  it("вложенный интервал — конфликт", () => {
    expect(overlaps(D(10), D(13), D(11), D(12))).toBe(true);
    expect(overlaps(D(11), D(12), D(10), D(13))).toBe(true);
  });
});

describe("freeWindows", () => {
  const busy: Busy[] = [
    { startAt: D(10), endAt: D(11) },
    { startAt: D(14), endAt: D(15) },
  ];

  it("не предлагает время, пересекающееся с занятым", () => {
    const slots = freeWindows({ dayStart: D(9), dayEnd: D(18), durationMin: 60, stepMin: 60, busy });
    const iso = slots.map((s) => s.toISOString());
    expect(iso).not.toContain(D(10).toISOString());
    expect(iso).not.toContain(D(14).toISOString());
  });

  it("предлагает время встык к занятому", () => {
    const slots = freeWindows({ dayStart: D(9), dayEnd: D(18), durationMin: 60, stepMin: 60, busy });
    const iso = slots.map((s) => s.toISOString());
    expect(iso).toContain(D(9).toISOString());
    expect(iso).toContain(D(11).toISOString());
  });

  it("не выходит за конец рабочего дня", () => {
    const slots = freeWindows({ dayStart: D(9), dayEnd: D(12), durationMin: 90, stepMin: 30, busy: [] });
    const last = slots[slots.length - 1];
    expect(last.getTime() + 90 * 60_000).toBeLessThanOrEqual(D(12).getTime());
  });

  it("длинная услуга не влезает между двумя занятыми окнами", () => {
    const tight: Busy[] = [
      { startAt: D(10), endAt: D(11) },
      { startAt: D(12), endAt: D(13) },
    ];
    // Между 11:00 и 12:00 ровно час — услуга на 90 минут туда не помещается.
    const slots = freeWindows({ dayStart: D(10), dayEnd: D(13), durationMin: 90, stepMin: 30, busy: tight });
    expect(slots).toHaveLength(0);
  });

  it("пустое расписание даёт слоты с шагом", () => {
    const slots = freeWindows({ dayStart: D(9), dayEnd: D(12), durationMin: 60, stepMin: 60, busy: [] });
    expect(slots.map((s) => s.toISOString())).toEqual([
      D(9).toISOString(),
      D(10).toISOString(),
      D(11).toISOString(),
    ]);
  });
});
