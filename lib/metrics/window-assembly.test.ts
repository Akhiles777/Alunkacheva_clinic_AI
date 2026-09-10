import { describe, expect, it } from "vitest";
import {
  assembleWindow,
  freedWindow,
  MAX_SHIFT_MIN,
  MAX_SUGGESTIONS,
  movable,
  moveIsSafe,
  type AssemblyContext,
  type Booking,
} from "./window-assembly";

const NOW = new Date("2026-09-10T10:00:00+03:00");
const DAY = new Date("2026-09-12T00:00:00+03:00");

const booking = (p: Partial<Booking> = {}): Booking => ({
  id: "b1",
  patientId: "p1",
  patientName: "Пациент",
  staffId: "s1",
  roomId: "room-1",
  serviceId: "srv-1",
  serviceTitle: "БОС-терапия",
  startMinute: 14 * 60,
  durationMin: 40,
  isFirstVisit: false,
  regular: true,
  date: DAY,
  ...p,
});

const ctx = (p: Partial<AssemblyContext> = {}): AssemblyContext => ({
  roomId: "room-1",
  needMin: 90,
  day: { startMinute: 9 * 60, endMinute: 21 * 60 },
  roomBusy: [{ id: "b1", startMinute: 14 * 60, endMinute: 14 * 60 + 40 }],
  staffBusy: { s1: [{ id: "b1", startMinute: 14 * 60, endMinute: 14 * 60 + 40 }] },
  staffShift: { s1: { startMinute: 9 * 60, endMinute: 21 * 60 } },
  serviceRooms: {},
  nowMinute: null,
  alreadyCalled: new Set(),
  ...p,
});

describe("что перенос не должен ломать", () => {
  it("не наезжает на другую запись в том же кабинете", () => {
    const c = ctx({
      roomBusy: [
        { id: "b1", startMinute: 840, endMinute: 880 },
        { id: "other", startMinute: 900, endMinute: 940 },
      ],
    });
    expect(moveIsSafe(booking(), 900, c)).toBe(false);
    expect(moveIsSafe(booking(), 940, c)).toBe(true);
  });

  it("не наезжает на другую запись того же специалиста в другом кабинете", () => {
    const c = ctx({
      staffBusy: { s1: [{ id: "b1", startMinute: 840, endMinute: 880 }, { id: "x", startMinute: 900, endMinute: 960 }] },
    });
    expect(moveIsSafe(booking(), 900, c)).toBe(false);
  });

  it("не выводит специалиста за смену", () => {
    const c = ctx({ staffShift: { s1: { startMinute: 9 * 60, endMinute: 15 * 60 } } });
    expect(moveIsSafe(booking(), 14 * 60 + 30, c)).toBe(false);
    expect(moveIsSafe(booking(), 14 * 60 + 10, c)).toBe(true);
  });

  it("смена неизвестна — не предлагаем вовсе", () => {
    expect(moveIsSafe(booking(), 900, ctx({ staffShift: { s1: null } }))).toBe(false);
  });

  it("не выводит за рабочие часы кабинета", () => {
    const c = ctx({ day: { startMinute: 9 * 60, endMinute: 15 * 60 } });
    expect(moveIsSafe(booking(), 14 * 60 + 30, c)).toBe(false);
  });

  it("не ставит услугу в кабинет, где она не проводится", () => {
    const c = ctx({ serviceRooms: { "srv-1": ["room-2"] } });
    expect(moveIsSafe(booking(), 900, c)).toBe(false);
  });

  it("новое время не в прошлом", () => {
    const c = ctx({ nowMinute: 15 * 60 });
    expect(moveIsSafe(booking(), 14 * 60, c)).toBe(false);
    expect(moveIsSafe(booking(), 16 * 60, c)).toBe(true);
  });
});

describe("кого можно предлагать двигать", () => {
  it("первичного — никогда", () => {
    expect(movable(booking({ isFirstVisit: true }), ctx(), NOW)).toBe(false);
  });

  it("случайного пациента не трогаем", () => {
    expect(movable(booking({ regular: false }), ctx(), NOW)).toBe(false);
  });

  it("завтрашнюю запись не трогаем: договориться не успеют", () => {
    const tomorrow = new Date("2026-09-11T00:00:00+03:00");
    expect(movable(booking({ date: tomorrow }), ctx(), NOW)).toBe(false);
    expect(movable(booking({ date: DAY }), ctx(), NOW)).toBe(true);
  });

  it("кому и так пишут — не трогаем", () => {
    const c = ctx({ alreadyCalled: new Set(["p1"]) });
    expect(movable(booking(), c, NOW)).toBe(false);
  });
});

describe("собранное окно", () => {
  it("перенос, освобождающий ровно нужное, предлагается", () => {
    // День 9:00–21:00. Занято 14:00–14:40 и 16:10–21:00 → сдвиг на 15:00
    // даёт окно 9:00–15:00, чего с запасом хватает на 90 минут.
    const c = ctx({
      needMin: 90,
      roomBusy: [
        { id: "b1", startMinute: 840, endMinute: 880 },
        { id: "tail", startMinute: 970, endMinute: 1260 },
      ],
      staffBusy: { s1: [{ id: "b1", startMinute: 840, endMinute: 880 }] },
    });
    const moves = assembleWindow([booking()], c, NOW);
    expect(moves.length).toBe(1);
    expect(moves[0].freed.endMinute - moves[0].freed.startMinute).toBeGreaterThanOrEqual(90);
  });

  it("перенос, освобождающий на минуту меньше нужного, не предлагается", () => {
    /**
     * Кабинет занят с 9:00 до 13:00 и с 14:40 до 21:00; двигать можно только
     * внутри 13:00–14:40, и максимум непрерывного места — 100 минут. Просим 101.
     */
    const c = ctx({
      needMin: 101,
      day: { startMinute: 9 * 60, endMinute: 21 * 60 },
      roomBusy: [
        { id: "head", startMinute: 540, endMinute: 780 },
        { id: "b1", startMinute: 840, endMinute: 880 },
        { id: "tail", startMinute: 880, endMinute: 1260 },
      ],
      staffBusy: { s1: [{ id: "b1", startMinute: 840, endMinute: 880 }] },
    });
    expect(assembleWindow([booking()], c, NOW)).toEqual([]);
  });

  it("предложений не больше трёх и они по возрастанию сдвига", () => {
    const bookings = [1, 2, 3, 4].map((i) =>
      booking({ id: `b${i}`, patientId: `p${i}`, startMinute: 600 + i * 60 }),
    );
    const c = ctx({
      needMin: 60,
      roomBusy: bookings.map((b) => ({
        id: b.id,
        startMinute: b.startMinute,
        endMinute: b.startMinute + b.durationMin,
      })),
      staffBusy: {
        s1: bookings.map((b) => ({
          id: b.id,
          startMinute: b.startMinute,
          endMinute: b.startMinute + b.durationMin,
        })),
      },
    });
    const moves = assembleWindow(bookings, c, NOW);
    expect(moves.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
    expect([...moves].sort((a, b) => a.shiftMin - b.shiftMin)).toEqual(moves);
  });

  it("дальше двух часов не двигаем", () => {
    const c = ctx({
      needMin: 600,
      roomBusy: [{ id: "b1", startMinute: 840, endMinute: 880 }],
      staffBusy: { s1: [{ id: "b1", startMinute: 840, endMinute: 880 }] },
    });
    const moves = assembleWindow([booking()], c, NOW);
    for (const m of moves) expect(m.shiftMin).toBeLessThanOrEqual(MAX_SHIFT_MIN);
  });

  it("освободившееся окно считается по настоящей занятости, а не по длине записи", () => {
    const c = ctx({
      roomBusy: [
        { id: "b1", startMinute: 840, endMinute: 880 },
        { id: "next", startMinute: 880, endMinute: 940 },
      ],
    });
    const freed = freedWindow(booking(), 940, c);
    // 9:00–14:00 свободно, дальше занято до 15:40 — окно 300 минут.
    expect(freed).toEqual({ startMinute: 540, endMinute: 880 });
  });
});
