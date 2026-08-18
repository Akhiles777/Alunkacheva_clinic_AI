import { describe, expect, it } from "vitest";
import { mapRecord, recordKnowsPrice } from "./mappers";
import type { YclientsRecord } from "./types";

function record(over: Partial<YclientsRecord>): YclientsRecord {
  return {
    id: 1,
    staff_id: 10,
    datetime: "2026-08-17T09:00:00+03:00",
    seance_length: 2700,
    ...over,
  };
}

/**
 * Жалоба клиники: пациентке сделали скидку 100%, а в отчёте у неё встало
 * 3000 ₽. Выгрузка закрывала ценой из прайса ЛЮБОЙ ноль — и настоящую
 * бесплатную услугу тоже.
 */
describe("знает ли запись свою цену", () => {
  it("скидка 100% — цена известна, ноль настоящий", () => {
    const dto = record({
      services: [{ id: 5, title: "Приём остеопата", cost: 0, first_cost: 3000, discount: 100 }],
    });
    expect(recordKnowsPrice(dto)).toBe(true);
    expect(mapRecord(dto).revenue).toBe(0);
    expect(mapRecord(dto).priceKnown).toBe(true);
  });

  it("стоимость просто не проставили — цена неизвестна", () => {
    const dto = record({ services: [{ id: 5, title: "Приём остеопата", cost: 0 }] });
    expect(recordKnowsPrice(dto)).toBe(false);
  });

  it("обычная платная услуга — цена известна", () => {
    const dto = record({ services: [{ id: 5, cost: 8000, first_cost: 8000, discount: 0 }] });
    expect(recordKnowsPrice(dto)).toBe(true);
    expect(mapRecord(dto).revenue).toBe(8000);
  });

  it("частичная скидка — берём итоговую стоимость, а не цену до скидки", () => {
    const dto = record({ services: [{ id: 5, cost: 2400, first_cost: 3000, discount: 20 }] });
    expect(mapRecord(dto).revenue).toBe(2400);
  });

  it("услуг в записи нет — цену взять неоткуда", () => {
    expect(recordKnowsPrice(record({ services: [] }))).toBe(false);
    expect(recordKnowsPrice(record({}))).toBe(false);
  });

  it("номер визита переносится: по нему видно, что записи — один приход", () => {
    expect(mapRecord(record({ visit_id: 777 })).yclientsVisitId).toBe(777);
    expect(mapRecord(record({})).yclientsVisitId).toBeNull();
  });
});
