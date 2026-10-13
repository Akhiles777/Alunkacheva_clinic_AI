import { describe, expect, it } from "vitest";
import { calculate } from "./calc";

describe("calculate", () => {
  it("считает с приоритетом и скобками", () => {
    expect(calculate("1745400 - 1900500")).toBe(-155100);
    expect(calculate("(1745400 - 1900500) / 1900500 * 100")).toBe(-8.16);
    expect(calculate("2 + 3 * 4")).toBe(14);
  });

  it("проценты и русские знаки", () => {
    expect(calculate("200000 * 15%")).toBe(30000);
    expect(calculate("10 × 3 − 4 ÷ 2")).toBe(28);
    expect(calculate("1,5 * 2")).toBe(3);
  });

  it("ничего, кроме арифметики", () => {
    expect(() => calculate("process.exit()")).toThrow();
    expect(() => calculate("1 / 0")).toThrow(/ноль/);
    expect(() => calculate("(1 + 2")).toThrow(/скобка/);
  });
});
