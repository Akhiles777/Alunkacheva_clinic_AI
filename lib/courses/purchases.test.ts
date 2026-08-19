import { describe, expect, it } from "vitest";
import { coursePurchases, type RawTransaction } from "./purchases";

/** Живые строки клиники: продажа курса БОС двумя платежами 17 августа. */
const SALE: RawTransaction[] = [
  {
    date: "2026-08-17T12:51:42+0400",
    amount: 13000,
    client: { id: 363033680 },
    sold_item_id: 1815455376,
    sold_item_type: "goods_transaction",
    record_id: 0,
    visit_id: 0,
  },
  {
    date: "2026-08-17T12:51:42+0400",
    amount: 15000,
    client: { id: 363033680 },
    sold_item_id: 1815455376,
    sold_item_type: "goods_transaction",
    record_id: 0,
    visit_id: 0,
  },
];

describe("продажа курса из кассовых операций", () => {
  it("две строки одной покупки складываются в 28 000 ₽", () => {
    const out = coursePurchases(SALE);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(28000);
    expect(out[0].clientId).toBe(363033680);
    expect(out[0].saleId).toBe(1815455376);
  });

  it("расходы не путаем с продажами", () => {
    // В кассе рядом лежат зарплата и закупка — суммой вниз.
    const out = coursePurchases([
      ...SALE,
      { date: "2026-08-19T16:01:00+0400", amount: -32000, client: { id: 363033680 } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(28000);
  });

  it("операция без клиента к курсу отношения не имеет", () => {
    // Пусто приходит массивом, а не null.
    expect(coursePurchases([{ date: "2026-08-17T12:00:00+0400", amount: 5000, client: [] }])).toEqual([]);
  });

  it("оплата конкретного приёма продажей курса не считается", () => {
    // Её стоимость уже стоит в записи: посчитать здесь — удвоить деньги.
    const out = coursePurchases([
      {
        date: "2026-08-17T12:00:00+0400",
        amount: 5000,
        client: { id: 7 },
        record_id: 1911624918,
        visit_id: 1667141067,
      },
    ]);
    expect(out).toEqual([]);
  });

  it("разные покупки одного клиента не склеиваются", () => {
    const out = coursePurchases([
      { date: "2026-06-01T10:00:00+0400", amount: 28000, client: { id: 7 }, sold_item_id: 1 },
      { date: "2026-08-01T10:00:00+0400", amount: 28000, client: { id: 7 }, sold_item_id: 2 },
    ]);
    expect(out).toHaveLength(2);
  });

  it("без номера продажи склеиваем по клиенту и минуте", () => {
    const out = coursePurchases([
      { date: "2026-06-01T10:00:30+0400", amount: 13000, client: { id: 7 } },
      { date: "2026-06-01T10:00:50+0400", amount: 15000, client: { id: 7 } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(28000);
  });

  it("днём продажи считаем самую раннюю строку покупки", () => {
    const out = coursePurchases([
      { date: "2026-08-17T13:00:00+0400", amount: 15000, client: { id: 7 }, sold_item_id: 9 },
      { date: "2026-08-17T12:51:00+0400", amount: 13000, client: { id: 7 }, sold_item_id: 9 },
    ]);
    expect(out[0].at.toISOString()).toBe(new Date("2026-08-17T12:51:00+0400").toISOString());
  });

  it("битая дата не роняет разбор", () => {
    expect(coursePurchases([{ date: "не дата", amount: 28000, client: { id: 7 } }])).toEqual([]);
  });

  it("пусто на входе — пусто на выходе", () => {
    expect(coursePurchases([])).toEqual([]);
  });
});
