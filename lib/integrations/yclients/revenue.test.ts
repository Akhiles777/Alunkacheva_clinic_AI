import { describe, expect, it } from "vitest";
import { mapRecord, recordRevenue, serviceRevenue } from "./mappers";
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
 * Строки ниже — из живого ответа YCLIENTS этой клиники. Первое правило считало
 * «цена известна» по любому следу цены и обнулило тысячу визитов на три
 * миллиона рублей: `first_cost` и `amount` провайдер кладёт всегда, и
 * незаполненная стоимость выглядела точно так же, как подарок.
 */
describe("стоимость одной услуги", () => {
  it("стоимость проставлена — это факт", () => {
    expect(serviceRevenue({ id: 1, cost: 8000, first_cost: 8000, discount: 0 })).toEqual({
      amount: 8000,
      source: "RECORD",
    });
  });

  it("скидка 100% — отдано даром", () => {
    expect(serviceRevenue({ id: 1, cost: 0, first_cost: 3000, discount: 100 })).toEqual({
      amount: 0,
      source: "FREE",
    });
  });

  it("цена по прайсу есть, скидки нет — стоимость не проставлена", () => {
    // Ровно эта строка на боевых данных: cost=0 first_cost=2800 discount=0.
    expect(serviceRevenue({ id: 1, cost: 0, first_cost: 2800, discount: 0, amount: 1 })).toEqual({
      amount: 2800,
      source: "PRICE_LIST",
    });
  });

  it("количество не путаем с деньгами", () => {
    // amount — это КОЛИЧЕСТВО услуг, а не сумма.
    expect(serviceRevenue({ id: 1, cost: 0, amount: 1 })).toEqual({ amount: 0, source: "UNKNOWN" });
  });

  it("частичная скидка — берём итоговую стоимость", () => {
    expect(serviceRevenue({ id: 1, cost: 2400, first_cost: 3000, discount: 20 }).amount).toBe(2400);
  });
});

describe("стоимость визита из нескольких услуг", () => {
  it("что даром — даром, что платно — платно", () => {
    // Требование заказчика дословно: одна позиция подарена, вторая платная —
    // в визите ровно столько денег, сколько стоит вторая.
    const dto = record({
      services: [
        { id: 5, cost: 0, first_cost: 3000, discount: 100 },
        { id: 6, cost: 900, first_cost: 900, discount: 0 },
      ],
    });
    expect(recordRevenue(dto)).toEqual({ amount: 900, source: "RECORD", unpriced: 0 });
    expect(mapRecord(dto).revenue).toBe(900);
  });

  it("все позиции подарены — визит бесплатный", () => {
    const dto = record({
      services: [
        { id: 5, cost: 0, first_cost: 3000, discount: 100 },
        { id: 6, cost: 0, first_cost: 900, discount: 100 },
      ],
    });
    expect(recordRevenue(dto)).toEqual({ amount: 0, source: "FREE", unpriced: 0 });
  });

  it("подставленная цена помечает весь визит: сумме верить меньше", () => {
    const dto = record({
      services: [
        { id: 5, cost: 8000, first_cost: 8000, discount: 0 },
        { id: 6, cost: 0, first_cost: 900, discount: 0 },
      ],
    });
    expect(recordRevenue(dto)).toEqual({ amount: 8900, source: "PRICE_LIST", unpriced: 0 });
  });

  it("цену взять неоткуда — ноль и честная пометка", () => {
    const dto = record({ services: [{ id: 5, cost: 0 }] });
    expect(recordRevenue(dto)).toEqual({ amount: 0, source: "UNKNOWN", unpriced: 1 });
  });

  it("услуг в записи нет", () => {
    expect(recordRevenue(record({ services: [] })).source).toBe("UNKNOWN");
  });

  it("номер визита переносится: по нему видно, что записи — один приход", () => {
    expect(mapRecord(record({ visit_id: 777 })).yclientsVisitId).toBe(777);
    expect(mapRecord(record({})).yclientsVisitId).toBeNull();
  });
});
