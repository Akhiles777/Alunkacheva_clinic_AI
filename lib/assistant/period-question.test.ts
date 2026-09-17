import { describe, expect, it } from "vitest";
import { periodFromQuestion } from "./period-question";
import { periodBounds, periodLabel } from "@/lib/server/analytics";

/** Разговор, из-за которого правило появилось: «срез за 1–18 сентября». */
const NOW = new Date("2026-09-18T12:00:00Z");

describe("periodFromQuestion", () => {
  it("узнаёт отрезок внутри месяца", () => {
    for (const q of [
      "СДЕЛАЙ СРЕЗ ПО ЗАГРУЗКЕ КАБИНЕТОВ ЗА 1 - 18 СЕНТЯБРЯ",
      "покажи выручку с 1 по 18 сентября",
      "как загружены кабинеты 1–18 сентября?",
    ]) {
      expect(periodFromQuestion(q, NOW), q).toBe("d2026-09-01..2026-09-18");
    }
  });

  it("узнаёт даты числами", () => {
    expect(periodFromQuestion("срез за 01.09–18.09", NOW)).toBe("d2026-09-01..2026-09-18");
  });

  it("«с 1 сентября» — до сегодня", () => {
    expect(periodFromQuestion("что у нас с 1 сентября по выручке?", NOW)).toBe(
      "d2026-09-01..2026-09-18",
    );
  });

  it("узнаёт месяц", () => {
    expect(periodFromQuestion("сколько было за август?", NOW)).toBe("2026-08");
    expect(periodFromQuestion("а в декабре?", NOW)).toBe("2025-12");
    expect(periodFromQuestion("итоги за прошлый месяц", NOW)).toBe("2026-08");
    expect(periodFromQuestion("как идёт этот месяц", NOW)).toBe("2026-09");
  });

  it("один названный день — отрезок из одного дня", () => {
    expect(periodFromQuestion("что было 5 сентября?", NOW)).toBe("d2026-09-05..2026-09-05");
    expect(periodFromQuestion("итоги за 1 сентября", NOW)).toBe("d2026-09-01..2026-09-01");
  });

  it("«за последние N дней» — отрезок до сегодня", () => {
    expect(periodFromQuestion("что у нас за последние 10 дней?", NOW)).toBe("d2026-09-09..2026-09-18");
    expect(periodFromQuestion("за последние 2 недели", NOW)).toBe("d2026-09-05..2026-09-18");
  });

  it("вопрос без периода — ничего не придумываем", () => {
    for (const q of ["кто из сотрудников работает эффективнее?", "где мы теряем деньги", ""]) {
      expect(periodFromQuestion(q, NOW), q).toBeNull();
    }
  });

  it("отрезок считается тем же кодом, что и отчёты", () => {
    const key = periodFromQuestion("срез за 1–18 сентября", NOW)!;
    const { from, to } = periodBounds(key, NOW);
    // Границы суток клиники: с 1 сентября 00:00 МСК по 19 сентября 00:00 МСК.
    expect(from.toISOString()).toBe("2026-08-31T21:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-18T21:00:00.000Z");
    expect(periodLabel(key)).toBe("1–18 сен");
  });
});
