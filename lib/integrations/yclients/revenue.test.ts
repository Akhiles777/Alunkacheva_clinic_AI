import { describe, expect, it } from "vitest";
import { mapRecord, recordIsFree, recordListPrice } from "./mappers";
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
 * Строки ниже — из живого ответа YCLIENTS этой клиники. Первая версия правила
 * считала «цена известна» по любому следу цены и обнулила тысячу визитов на
 * три миллиона рублей: `first_cost` и `amount` провайдер кладёт всегда, и
 * незаполненная стоимость выглядела точно так же, как подарок.
 */
describe("бесплатно или цена не проставлена", () => {
  it("скидка 100% — услуга отдана даром", () => {
    const dto = record({
      services: [{ id: 5, cost: 0, first_cost: 3000, discount: 100, amount: 1, cost_to_pay: 0 }],
    });
    expect(recordIsFree(dto)).toBe(true);
    expect(mapRecord(dto).isFree).toBe(true);
  });

  it("цена по прайсу есть, скидки нет — стоимость просто не проставлена", () => {
    // Ровно эта строка на боевых данных: cost=0 first_cost=2800 discount=0.
    const dto = record({
      services: [{ id: 5, cost: 0, first_cost: 2800, discount: 0, amount: 1, cost_to_pay: 0 }],
    });
    expect(recordIsFree(dto)).toBe(false);
    expect(recordListPrice(dto)).toBe(2800);
  });

  it("количество не путаем с деньгами", () => {
    // amount — это КОЛИЧЕСТВО услуг. По нему цену определять нельзя.
    const dto = record({ services: [{ id: 5, cost: 0, amount: 1 }] });
    expect(recordIsFree(dto)).toBe(false);
    expect(recordListPrice(dto)).toBe(0);
  });

  it("обычная платная услуга", () => {
    const dto = record({ services: [{ id: 5, cost: 8000, first_cost: 8000, discount: 0 }] });
    expect(mapRecord(dto).revenue).toBe(8000);
    expect(recordIsFree(dto)).toBe(false);
  });

  it("частичная скидка — берём итоговую стоимость", () => {
    const dto = record({ services: [{ id: 5, cost: 2400, first_cost: 3000, discount: 20 }] });
    expect(mapRecord(dto).revenue).toBe(2400);
    expect(recordIsFree(dto)).toBe(false);
  });

  it("одна услуга подарена, вторая платная — визит не бесплатный", () => {
    const dto = record({
      services: [
        { id: 5, cost: 0, first_cost: 3000, discount: 100 },
        { id: 6, cost: 900, first_cost: 900, discount: 0 },
      ],
    });
    expect(recordIsFree(dto)).toBe(false);
  });

  it("услуг в записи нет — ни цены, ни подарка", () => {
    expect(recordIsFree(record({ services: [] }))).toBe(false);
    expect(recordIsFree(record({}))).toBe(false);
  });

  it("номер визита переносится: по нему видно, что записи — один приход", () => {
    expect(mapRecord(record({ visit_id: 777 })).yclientsVisitId).toBe(777);
    expect(mapRecord(record({})).yclientsVisitId).toBeNull();
  });
});
