import { describe, expect, it } from "vitest";
import { buildDiff, diffIds } from "./reconcile";

/**
 * Ядро сверки. Ошибка здесь означала бы ложное «всё сошлось» — худший исход:
 * платформа отчиталась бы о полной выгрузке, которой не было.
 */
describe("diffIds", () => {
  it("находит то, что не доехало", () => {
    expect(diffIds([1, 2, 3], [1, 3])).toEqual({ missingLocally: [2], staleLocally: [] });
  });

  it("находит лишнее у нас: удалили после выгрузки", () => {
    expect(diffIds([1, 2], [1, 2, 9])).toEqual({ missingLocally: [], staleLocally: [9] });
  });

  it("полное совпадение даёт пустые списки", () => {
    expect(diffIds([5, 1], [1, 5])).toEqual({ missingLocally: [], staleLocally: [] });
  });

  it("повторы не создают ложных расхождений", () => {
    expect(diffIds([1, 1, 2], [2, 1])).toEqual({ missingLocally: [], staleLocally: [] });
  });

  it("пустые наборы сходятся", () => {
    expect(diffIds([], [])).toEqual({ missingLocally: [], staleLocally: [] });
  });
});

describe("buildDiff", () => {
  it("считает уникальные, а не сырые количества", () => {
    const d = buildDiff("Услуги", [1, 1, 2], [1, 2]);
    expect(d.remote).toBe(2);
    expect(d.local).toBe(2);
    expect(d.ok).toBe(true);
  });

  it("расхождение помечается как несошедшееся", () => {
    expect(buildDiff("Визиты", [1, 2, 3], [1]).ok).toBe(false);
  });

  it("список расхождений обрезается, чтобы отчёт можно было прочитать", () => {
    const many = Array.from({ length: 100 }, (_, i) => i + 1);
    const d = buildDiff("Пациенты", many, []);
    expect(d.missingLocally).toHaveLength(20);
    expect(d.remote).toBe(100);
    expect(d.ok).toBe(false);
  });
});
