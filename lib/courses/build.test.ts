import { describe, expect, it } from "vitest";
import { buildCourses, looksLikeCourseSale, pricePerSession, type CourseVisit } from "./build";

const day = (d: number): Date => new Date(`2026-08-${String(d).padStart(2, "0")}T09:00:00+03:00`);
const visit = (id: string, d: number, revenue = 0): CourseVisit => ({ id, startAt: day(d), revenue });
/** Живые числа клиники: сеанс БОС стоит 2 800 ₽, курс из десяти — 25 000 ₽. */
const BOS = { sessionPrice: 2800, sessionsTotal: 10 };

describe("похожа ли оплата на продажу курса", () => {
  it("цена одного сеанса — это платный приём, а не курс", () => {
    expect(looksLikeCourseSale(2800, 2800)).toBe(false);
  });

  it("двадцать пять тысяч при цене 2 800 — продажа курса", () => {
    // Курс из десяти сеансов стоит 28 000 ₽, продают за 25 000 со скидкой.
    // Делить сумму на цену нельзя: вышло бы «9 из 10».
    expect(looksLikeCourseSale(25000, 2800)).toBe(true);
  });

  it("исторические цены ниже нынешней курсом не становятся", () => {
    // В базе есть оплаты 2 500 и 2 300 — так стоил сеанс раньше.
    expect(looksLikeCourseSale(2500, 2800)).toBe(false);
    expect(looksLikeCourseSale(2300, 2800)).toBe(false);
  });

  it("цена сеанса неизвестна — судить не о чем", () => {
    expect(looksLikeCourseSale(25000, 0)).toBe(false);
  });
});

describe("сборка курса из записей", () => {
  it("продажа курса открывает курс, нули к нему прикрепляются", () => {
    const plan = buildCourses(
      [visit("v1", 1, 25000), visit("v2", 3), visit("v3", 5), visit("v4", 7)],
      BOS,
    );
    expect(plan.courses).toHaveLength(1);
    expect(plan.courses[0].amount).toBe(25000);
    // Десять — из справочника клиники, а не из деления 25 000 на 2 800.
    expect(plan.courses[0].sessionsTotal).toBe(10);
    expect(plan.courses[0].purchasedAt).toEqual(day(1));
    expect(plan.courses[0].visitIds).toEqual(["v1", "v2", "v3", "v4"]);
  });

  it("оплата одного сеанса курса не открывает", () => {
    // Ровно это и рисовало на экране «БОС-терапия 1/2»: семьдесят два платежа
    // по цене сеанса превращались в семьдесят два крошечных «курса».
    const plan = buildCourses([visit("v1", 1, 2800), visit("v2", 3)], BOS);
    expect(plan.courses).toEqual([]);
    expect(plan.orphans).toEqual(["v2"]);
  });

  it("платный приём внутри курса курс не рвёт", () => {
    const plan = buildCourses(
      [visit("v1", 1, 25000), visit("v2", 3), visit("v3", 4, 2800), visit("v4", 5)],
      BOS,
    );
    expect(plan.courses).toHaveLength(1);
    expect(plan.courses[0].visitIds).toEqual(["v1", "v2", "v4"]);
  });

  it("день продажи — это день оплаты, а не день последнего сеанса", () => {
    const plan = buildCourses([visit("v1", 1, 25000), visit("v2", 20)], BOS);
    expect(plan.courses[0].purchasedAt).toEqual(day(1));
  });

  it("вторая продажа открывает второй курс", () => {
    const plan = buildCourses(
      [visit("v1", 1, 25000), visit("v2", 3), visit("v3", 10, 25000), visit("v4", 12)],
      BOS,
    );
    expect(plan.courses).toHaveLength(2);
    expect(plan.courses[1].visitIds).toEqual(["v3", "v4"]);
  });

  it("сеансов больше проданного — лишние не приписываем", () => {
    const plan = buildCourses(
      [visit("v1", 1, 25000), visit("v2", 2), visit("v3", 3)],
      { sessionPrice: 2800, sessionsTotal: 2 },
    );
    expect(plan.courses[0].visitIds).toEqual(["v1", "v2"]);
    expect(plan.orphans).toEqual(["v3"]);
  });

  it("сеансы без продажи в данных — курс куплен абонементом", () => {
    // Именно этот случай у клиники массовый: семь сеансов подряд без единой
    // оплаты в записях. Придумывать им курс нельзя.
    const plan = buildCourses([visit("v1", 1), visit("v2", 3)], BOS);
    expect(plan.courses).toEqual([]);
    expect(plan.orphans).toEqual(["v1", "v2"]);
  });

  it("цена сеанса неизвестна — курсов не собираем вовсе", () => {
    const plan = buildCourses([visit("v1", 1, 25000), visit("v2", 3)], {
      sessionPrice: 0,
      sessionsTotal: 10,
    });
    expect(plan.courses).toEqual([]);
  });

  it("порядок визитов восстанавливается сам", () => {
    const plan = buildCourses([visit("v2", 5), visit("v1", 1, 25000)], BOS);
    expect(plan.courses[0].visitIds).toEqual(["v1", "v2"]);
  });

  it("пусто на входе — пусто на выходе", () => {
    expect(buildCourses([], BOS)).toEqual({ courses: [], orphans: [] });
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
