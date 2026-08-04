import { describe, expect, it } from "vitest";
import { calcPayroll } from "./calc";

/**
 * Пример заказчика: 120 часов по 180 ₽ = 21 600 ₽ начислено, 20 процедур по
 * 500 ₽ = 10 000 ₽ выдано в смены, остаток к выплате 11 600 ₽.
 * Прежняя программа показывала здесь завышенную сумму — проверяем именно это.
 */
describe("calcPayroll", () => {
  const base = {
    workedMinutes: 120 * 60,
    hourlyRate: 180,
    procedures: 20,
    perProcedureRate: 500,
  };

  it("считает пример клиники в точности", () => {
    const r = calcPayroll(base);
    expect(r.hours).toBe(120);
    expect(r.accrued).toBe(21600);
    expect(r.expectedAdvance).toBe(10000);
    expect(r.remainder).toBe(11600);
  });

  it("выплаты за процедуры вычитаются, а не прибавляются", () => {
    const r = calcPayroll(base);
    // Ошибка прежней программы дала бы 21600 + 10000 = 31600.
    expect(r.remainder).not.toBe(31600);
    expect(r.remainder).toBeLessThan(r.accrued);
  });

  it("учитывает фактическую выдачу, если она отличается от ожидаемой", () => {
    const r = calcPayroll({ ...base, paidOut: 9500 });
    expect(r.paidOut).toBe(9500);
    expect(r.remainder).toBe(12100);
    // Одну выдачу забыли отметить — расхождение видно.
    expect(r.advanceMismatch).toBe(-500);
  });

  it("переплата даёт отрицательный остаток", () => {
    const r = calcPayroll({ ...base, paidOut: 25000 });
    expect(r.remainder).toBe(-3400);
  });

  it("неполный час считается дробно", () => {
    const r = calcPayroll({ workedMinutes: 90, hourlyRate: 180, procedures: 0, perProcedureRate: 500 });
    expect(r.hours).toBe(1.5);
    expect(r.accrued).toBe(270);
  });

  it("нулевые данные не ломают расчёт", () => {
    const r = calcPayroll({ workedMinutes: 0, hourlyRate: 0, procedures: 0, perProcedureRate: 0 });
    expect(r).toMatchObject({ hours: 0, accrued: 0, remainder: 0 });
  });

  it("отрицательные входные значения не создают отрицательных начислений", () => {
    const r = calcPayroll({ workedMinutes: -100, hourlyRate: -5, procedures: -3, perProcedureRate: -1 });
    expect(r.accrued).toBe(0);
    expect(r.expectedAdvance).toBe(0);
  });
});
