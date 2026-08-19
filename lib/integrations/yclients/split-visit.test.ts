import { describe, expect, it } from "vitest";
import { splitVisitMinutes } from "./split-visit";

const part = (serviceId: string, minutes: number, amount = 0, quantity = 1) => ({
  serviceId,
  minutes,
  amount,
  quantity,
});

/**
 * Разрез по услугам и разрез по кабинетам считают один и тот же период. Если
 * части визита не сойдутся с его длительностью, два экрана покажут разные
 * итоги — на таких расхождениях этот проект уже обжигался.
 */
describe("время визита по услугам", () => {
  it("одна услуга забирает всё время визита", () => {
    expect(splitVisitMinutes([part("a", 60)], 45)).toEqual([
      { serviceId: "a", durationMin: 45, quantity: 1, priceCharged: 0 },
    ]);
  });

  it("две услуги делятся пропорционально", () => {
    const out = splitVisitMinutes([part("a", 60), part("b", 30)], 90);
    expect(out.map((r) => r.durationMin)).toEqual([60, 30]);
  });

  it("сумма частей всегда равна длительности визита", () => {
    // Здесь деление нацело не выходит: 50 на трёх — 16.67 каждому.
    for (const visit of [50, 45, 7, 100, 13]) {
      const out = splitVisitMinutes([part("a", 10), part("b", 10), part("c", 10)], visit);
      expect(out.reduce((s, r) => s + r.durationMin, 0), `визит ${visit}`).toBe(visit);
    }
  });

  it("длительностей нет ни у одной — делим поровну", () => {
    const out = splitVisitMinutes([part("a", 0), part("b", 0)], 60);
    expect(out.map((r) => r.durationMin)).toEqual([30, 30]);
    expect(out.reduce((s, r) => s + r.durationMin, 0)).toBe(60);
  });

  it("услуг нет — делить нечего", () => {
    expect(splitVisitMinutes([], 60)).toEqual([]);
  });

  it("нулевой визит не ломает деление", () => {
    const out = splitVisitMinutes([part("a", 30), part("b", 30)], 0);
    expect(out.reduce((s, r) => s + r.durationMin, 0)).toBe(0);
  });

  it("деньги и количество переносятся как есть", () => {
    const out = splitVisitMinutes([part("a", 30, 2800, 2)], 30);
    expect(out[0]).toEqual({ serviceId: "a", durationMin: 30, quantity: 2, priceCharged: 2800 });
  });
});
