import { describe, expect, it } from "vitest";
import { titleFrom } from "./chat-title";

describe("заголовок сохранённого разбора", () => {
  it("короткий вопрос становится названием как есть", () => {
    expect(titleFrom("Где мы теряем деньги?")).toBe("Где мы теряем деньги?");
  });

  it("длинный обрезается по слову, а не по букве", () => {
    const q = "Проведи глубокий анализ клиники и дай три гипотезы, что улучшить";
    const t = titleFrom(q);
    expect(t.endsWith("…")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(41);
    // Слово должно закончиться: то, что осталось, — целые слова исходника.
    const body = t.slice(0, -1);
    expect(q.startsWith(body)).toBe(true);
    expect(q[body.length]).toBe(" ");
    expect(t).toBe("Проведи глубокий анализ клиники и дай…");
  });

  it("длинное слово без пробелов обрезается по букве — деваться некуда", () => {
    expect(titleFrom("а".repeat(60))).toBe(`${"а".repeat(40)}…`);
  });

  it("лишние пробелы и переносы схлопываются", () => {
    expect(titleFrom("  выручка\n\nза   квартал ")).toBe("выручка за квартал");
  });

  it("пустой вопрос всё равно даёт название", () => {
    expect(titleFrom("   ")).toBe("Новый разбор");
  });
});
