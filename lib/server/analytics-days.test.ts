import { describe, expect, it } from "vitest";
import { workingDaysBetween, workingMinutesBetween } from "./analytics";
import type { Interval } from "@/lib/metrics/occupancy";

/**
 * Знаменатель загрузки кабинетов. Период считается от полуночи клиники —
 * для Москвы это 21:00 предыдущих суток по UTC. Пока день недели и дата брались
 * по часам сервера и по UTC, перебор дней съезжал на сутки: график субботы
 * применялся к пятнице, а закрытые дни не исключались никогда.
 */
const august = {
  // 1 августа 2026 года — суббота.
  from: new Date("2026-07-31T21:00:00Z"),
  to: new Date("2026-08-07T21:00:00Z"), // неделя: сб, вс, пн…пт
};

// Будни 08:00–16:00 (480 мин), суббота 09:00–16:00 (420), воскресенье закрыто.
const schedule = new Map<number, Interval>([
  [1, { startMinute: 480, endMinute: 960 }],
  [2, { startMinute: 480, endMinute: 960 }],
  [3, { startMinute: 480, endMinute: 960 }],
  [4, { startMinute: 480, endMinute: 960 }],
  [5, { startMinute: 480, endMinute: 960 }],
  [6, { startMinute: 540, endMinute: 960 }],
]);

describe("рабочие минуты периода", () => {
  it("считает по графику клиники, а не по дням сервера", () => {
    // Суббота 420 + пять будней по 480; воскресенья в графике нет.
    expect(workingMinutesBetween(august.from, august.to, schedule)).toBe(420 + 5 * 480);
  });

  it("закрытый день не идёт в знаменатель", () => {
    // Ключ закрытого дня — дата клиники. Прежде он считался в UTC и был на
    // день раньше, поэтому не совпадал ни с одним праздником.
    const closed = new Set(["2026-08-03"]); // понедельник
    expect(workingMinutesBetween(august.from, august.to, schedule, closed)).toBe(
      420 + 4 * 480,
    );
  });

  it("пустой график — запасные двенадцать часов на каждый день", () => {
    expect(workingMinutesBetween(august.from, august.to, new Map())).toBe(7 * 12 * 60);
  });
});

describe("рабочие дни периода", () => {
  it("воскресенье не рабочий день", () => {
    expect(workingDaysBetween(august.from, august.to)).toBe(6);
  });

  it("закрытый день вычитается", () => {
    expect(workingDaysBetween(august.from, august.to, new Set(["2026-08-05"]))).toBe(5);
  });
});
