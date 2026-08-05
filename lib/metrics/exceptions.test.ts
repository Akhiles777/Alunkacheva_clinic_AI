import { describe, expect, it } from "vitest";
import { workingWindowForDay } from "./occupancy";

/**
 * Исключения расписания: праздник, санитарный день, укороченный день.
 *
 * Проверка появилась, когда выяснилось, что раздел «Исключения» в настройках
 * был декорацией: кнопка добавляла строку с неизменяемой датой, а прочитать
 * исключения не пробовал никто — ни запись, ни загрузка кабинетов, ни отчёты.
 * Клиника закрывалась на праздник, а платформа продолжала предлагать окна.
 */
const REGULAR = { weekday: 1, startMinute: 9 * 60, endMinute: 21 * 60 };

describe("workingWindowForDay", () => {
  it("без исключения работает обычное расписание", () => {
    expect(workingWindowForDay(REGULAR)).toEqual({ startMinute: 540, endMinute: 1260 });
  });

  it("закрытый день не даёт окна вовсе", () => {
    expect(workingWindowForDay(REGULAR, { isClosed: true })).toBeNull();
  });

  it("укороченный день сужает окно", () => {
    expect(
      workingWindowForDay(REGULAR, { isClosed: false, startMinute: 10 * 60, endMinute: 15 * 60 }),
    ).toEqual({ startMinute: 600, endMinute: 900 });
  });

  it("укороченный день без часов оставляет обычное расписание", () => {
    expect(workingWindowForDay(REGULAR, { isClosed: false })).toEqual({
      startMinute: 540,
      endMinute: 1260,
    });
  });

  it("перевёрнутое окно исключения не создаёт отрицательного дня", () => {
    expect(
      workingWindowForDay(REGULAR, { isClosed: false, startMinute: 18 * 60, endMinute: 10 * 60 }),
    ).toBeNull();
  });

  it("выходной по недельному расписанию остаётся выходным", () => {
    expect(workingWindowForDay(null)).toBeNull();
  });
});
