import { describe, expect, it } from "vitest";
import {
  revenueByService,
  revenueByStaff,
  type CourseSaleForRevenue,
  type VisitForRevenue,
} from "./service-revenue";

const visit = (over: Partial<VisitForRevenue> = {}): VisitForRevenue => ({
  status: "arrived",
  doctor: "Ирина Омарова",
  price: 0,
  service: "БОС-терапия",
  parts: [],
  ...over,
});

const sale = (over: Partial<CourseSaleForRevenue> = {}): CourseSaleForRevenue => ({
  serviceTitle: "БОС-терапия",
  staffName: "Ирина Омарова",
  amount: 28000,
  ...over,
});

describe("выручка по услугам", () => {
  it("сеансы курса дают ноль, а продажа — свои деньги", () => {
    // Ровно то, что видел заказчик: «БОС-терапия 41 приём, 0 ₽».
    const rows = revenueByService(
      [visit({ parts: [{ title: "БОС-терапия", amount: 0 }] })],
      [sale()],
    );
    expect(rows[0]).toEqual({ name: "БОС-терапия", count: 1, revenue: 28000 });
  });

  it("продажа курса приёмом не считается", () => {
    // Приёмом были его сеансы, и они уже посчитаны: иначе число вырастет зря.
    const rows = revenueByService([], [sale()]);
    expect(rows[0]).toEqual({ name: "БОС-терапия", count: 0, revenue: 28000 });
  });

  it("визит из двух услуг делит деньги между ними, а не удваивает", () => {
    const rows = revenueByService([
      visit({
        price: 8900,
        parts: [
          { title: "Остеопатия", amount: 8000 },
          { title: "Анализы", amount: 900 },
        ],
      }),
    ]);
    expect(rows).toEqual([
      { name: "Остеопатия", count: 1, revenue: 8000 },
      { name: "Анализы", count: 1, revenue: 900 },
    ]);
  });

  it("состав не записан — берём основную услугу и сумму визита", () => {
    const rows = revenueByService([visit({ price: 5000, service: "Остеопатия" })]);
    expect(rows[0]).toEqual({ name: "Остеопатия", count: 1, revenue: 5000 });
  });

  it("несостоявшийся визит в разрез не идёт", () => {
    expect(revenueByService([visit({ status: "planned", price: 5000 })])).toEqual([]);
  });
});

describe("выручка по специалистам", () => {
  it("курс достаётся тому, кто его ведёт", () => {
    // Без этого БОС-терапевт: пятьдесят девять приёмов и четыре тысячи.
    const rows = revenueByStaff([visit(), visit()], [sale()]);
    expect(rows[0]).toEqual({ name: "Ирина Омарова", count: 2, revenue: 28000 });
  });

  it("курс без специалиста в разрез по людям не идёт", () => {
    const rows = revenueByStaff([visit({ price: 4000 })], [sale({ staffName: null })]);
    expect(rows[0]).toEqual({ name: "Ирина Омарова", count: 1, revenue: 4000 });
  });

  it("приёмы считаются по визитам, а не по услугам в них", () => {
    // Визит из двух услуг — один приём специалиста, а не два.
    const rows = revenueByStaff([
      visit({
        price: 8900,
        parts: [
          { title: "Остеопатия", amount: 8000 },
          { title: "Анализы", amount: 900 },
        ],
      }),
    ]);
    expect(rows[0].count).toBe(1);
    expect(rows[0].revenue).toBe(8900);
  });
});
