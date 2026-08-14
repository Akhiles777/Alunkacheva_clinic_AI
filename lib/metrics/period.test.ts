import { describe, expect, it } from "vitest";
import { isMonthKey, isPeriodKey, monthBounds, monthLabel } from "./types";

/**
 * Календарный месяц в отчётах. Скользящее окно отвечает на вопрос «как идут
 * дела сейчас», месяц — на «сколько было в мае»; подменять одно другим нельзя.
 */
describe("период — календарный месяц", () => {
  it("узнаёт месяц и отвергает мусор", () => {
    expect(isMonthKey("2026-05")).toBe(true);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("2026-00")).toBe(false);
    expect(isMonthKey("1999-05")).toBe(false);
    expect(isMonthKey("май")).toBe(false);
    expect(isMonthKey(undefined)).toBe(false);
  });

  it("скользящие окна остались", () => {
    for (const k of ["week", "month", "quarter", "2026-03"]) expect(isPeriodKey(k)).toBe(true);
    expect(isPeriodKey("год")).toBe(false);
  });

  it("границы месяца — по времени клиники, а не по Гринвичу", () => {
    // Разница в три часа переносила бы визиты первого числа в предыдущий месяц.
    const { from, to } = monthBounds("2026-05");
    expect(from.toISOString()).toBe("2026-04-30T21:00:00.000Z");
    expect(to.toISOString()).toBe("2026-05-31T21:00:00.000Z");
  });

  it("декабрь переходит в следующий год", () => {
    const { to } = monthBounds("2026-12");
    expect(to.toISOString()).toBe("2026-12-31T21:00:00.000Z");
  });

  it("подпись читает человек", () => {
    expect(monthLabel("2026-05")).toBe("Май 2026");
    expect(monthLabel("2025-11")).toBe("Ноябрь 2025");
  });
});
