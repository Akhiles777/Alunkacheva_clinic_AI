import { describe, expect, it } from "vitest";
import { courseSessionRevenue, recognizeVisitRevenue, splitCourseAmount } from "./courses";

describe("splitCourseAmount", () => {
  it("делит ровную сумму поровну", () => {
    expect(splitCourseAmount(65000, 10)).toEqual(Array(10).fill(6500));
  });

  it("остаток от неровного деления кладёт на последний сеанс", () => {
    const parts = splitCourseAmount(10000, 3);
    expect(parts).toEqual([3333.33, 3333.33, 3333.34]);
  });

  it("сумма долей всегда равна сумме курса — курс сходится с кассой", () => {
    const cases: [number, number][] = [
      [65000, 10],
      [48000, 8],
      [59900, 12],
      [10000, 3],
      [0.03, 2],
      [1, 7],
    ];

    for (const [amount, sessions] of cases) {
      const parts = splitCourseAmount(amount, sessions);
      const sum = parts.reduce((total, part) => Math.round((total + part) * 100) / 100, 0);
      expect(sum, `${amount} / ${sessions}`).toBe(amount);
      expect(parts).toHaveLength(sessions);
    }
  });

  it("не порождает копеечный дрейф на длинных курсах", () => {
    const parts = splitCourseAmount(59900, 12);
    expect(parts.slice(0, 11)).toEqual(Array(11).fill(4991.66));
    expect(parts[11]).toBe(4991.74);
  });

  it("ругается на бессмысленный ввод", () => {
    expect(() => splitCourseAmount(1000, 0)).toThrow(RangeError);
    expect(() => splitCourseAmount(1000, -3)).toThrow(RangeError);
    expect(() => splitCourseAmount(1000, 2.5)).toThrow(RangeError);
    expect(() => splitCourseAmount(-1, 2)).toThrow(RangeError);
  });
});

describe("courseSessionRevenue", () => {
  it("возвращает долю конкретного сеанса", () => {
    expect(courseSessionRevenue(10000, 3, 1)).toBe(3333.33);
    expect(courseSessionRevenue(10000, 3, 3)).toBe(3333.34);
  });

  it("не пускает номер сеанса за пределы курса", () => {
    expect(() => courseSessionRevenue(10000, 3, 0)).toThrow(RangeError);
    expect(() => courseSessionRevenue(10000, 3, 4)).toThrow(RangeError);
  });
});

describe("recognizeVisitRevenue", () => {
  it("разовый визит признаёт целиком", () => {
    expect(recognizeVisitRevenue({ paidAmount: 7000, course: null })).toBe(7000);
  });

  it("курсовой визит признаёт долей курса, а не суммой продажи", () => {
    const revenue = recognizeVisitRevenue({
      paidAmount: 0,
      course: { amount: 65000, sessionsTotal: 10 },
      courseSessionIndex: 4,
    });
    expect(revenue).toBe(6500);
  });

  it("продажа курса не даёт пик в один день", () => {
    // Десять сеансов за 65 000 ₽: в день продажи признаётся 6 500, а не всё.
    const course = { amount: 65000, sessionsTotal: 10 };
    const daily = Array.from({ length: 10 }, (_, index) =>
      recognizeVisitRevenue({ paidAmount: 0, course, courseSessionIndex: index + 1 }),
    );

    expect(Math.max(...daily)).toBe(6500);
    expect(daily.reduce((sum, value) => sum + value, 0)).toBe(65000);
  });

  it("курсовой визит без номера сеанса выручку не признаёт", () => {
    // Лучше ноль, чем задвоение с продажей курса.
    expect(
      recognizeVisitRevenue({
        paidAmount: 65000,
        course: { amount: 65000, sessionsTotal: 10 },
        courseSessionIndex: null,
      }),
    ).toBe(0);
  });
});
