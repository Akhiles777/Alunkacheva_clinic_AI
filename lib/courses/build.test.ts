import { describe, expect, it } from "vitest";
import { buildCourses, pricePerSession, type CourseVisit } from "./build";

const day = (d: number): Date => new Date(`2026-08-${String(d).padStart(2, "0")}T09:00:00+03:00`);
const visit = (id: string, d: number, revenue = 0): CourseVisit => ({ id, startAt: day(d), revenue });

describe("сборка курса из записей", () => {
  it("оплата открывает курс, нули к нему прикрепляются", () => {
    // Ровно случай клиники: 28 000 ₽ за десять сеансов БОС в день продажи.
    const plan = buildCourses(
      [visit("v1", 1, 28000), visit("v2", 3), visit("v3", 5), visit("v4", 7)],
      10,
    );
    expect(plan.courses).toHaveLength(1);
    expect(plan.courses[0].amount).toBe(28000);
    expect(plan.courses[0].purchasedAt).toEqual(day(1));
    expect(plan.courses[0].visitIds).toEqual(["v1", "v2", "v3", "v4"]);
    expect(plan.orphans).toEqual([]);
  });

  it("день продажи — это день оплаты, а не день последнего сеанса", () => {
    const plan = buildCourses([visit("v1", 1, 28000), visit("v2", 20)], 10);
    expect(plan.courses[0].purchasedAt).toEqual(day(1));
  });

  it("вторая оплата открывает второй курс", () => {
    const plan = buildCourses(
      [visit("v1", 1, 28000), visit("v2", 3), visit("v3", 10, 28000), visit("v4", 12)],
      10,
    );
    expect(plan.courses).toHaveLength(2);
    expect(plan.courses[1].visitIds).toEqual(["v3", "v4"]);
  });

  it("сеансов больше проданного — лишние не приписываем", () => {
    const plan = buildCourses(
      [visit("v1", 1, 6000), visit("v2", 2), visit("v3", 3), visit("v4", 4)],
      2,
    );
    expect(plan.courses[0].visitIds).toEqual(["v1", "v2"]);
    expect(plan.orphans).toEqual(["v3", "v4"]);
  });

  it("сеансы без оплаты в данных — курс куплен до выгрузки", () => {
    // Историю мы выгрузили не с самого начала: продажа осталась за краем.
    // Придумывать ей сумму нельзя — это была бы выдуманная выручка.
    const plan = buildCourses([visit("v1", 1), visit("v2", 3)], 10);
    expect(plan.courses).toEqual([]);
    expect(plan.orphans).toEqual(["v1", "v2"]);
  });

  it("порядок визитов восстанавливается сам", () => {
    const plan = buildCourses([visit("v2", 5), visit("v1", 1, 28000)], 10);
    expect(plan.courses[0].visitIds).toEqual(["v1", "v2"]);
  });

  it("пусто на входе — пусто на выходе", () => {
    expect(buildCourses([], 10)).toEqual({ courses: [], orphans: [] });
  });
});

describe("цена сеанса", () => {
  it("ровное деление", () => {
    expect(pricePerSession(28000, 10)).toBe(2800);
  });

  it("неровное деление округляется до копейки", () => {
    expect(pricePerSession(10000, 3)).toBe(3333.33);
  });

  it("нулевое число сеансов не роняет расчёт", () => {
    expect(pricePerSession(5000, 0)).toBe(5000);
  });
});
