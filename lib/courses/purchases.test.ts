import { describe, expect, it } from "vitest";
import { coursePurchases, type RawTransaction } from "./purchases";

/** Живые строки клиники: продажа курса БОС двумя платежами 17 августа. */
const SALE: RawTransaction[] = [
  {
    id: 1815455301,
    date: "2026-08-17T12:51:42+0400",
    amount: 13000,
    client: { id: 363033680 },
    sold_item_id: 1815455376,
    sold_item_type: "goods_transaction",
    record_id: 0,
    visit_id: 0,
  },
  {
    id: 1815455302,
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
      { id: 9, date: "2026-08-19T16:01:00+0400", amount: -32000, client: { id: 363033680 } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(28000);
  });

  it("операция без клиента к курсу отношения не имеет", () => {
    // Пусто приходит массивом, а не null.
    expect(
      coursePurchases([
        { date: "2026-08-17T12:00:00+0400", amount: 5000, client: [], sold_item_type: "goods_transaction" },
      ]),
    ).toEqual([]);
  });

  it("та же операция дважды не удваивает курс", () => {
    // Страницы выгрузки приходят внахлёст; строки одной продажи складываются,
    // и повтор превратил бы курс за 28 000 ₽ в курс за 56 000 ₽.
    expect(coursePurchases([...SALE, ...SALE])[0].amount).toBe(28000);
  });

  it("движение денег без вида проданного продажей не считаем", () => {
    // Наличная оплата обычного приёма без номера записи открывала бы пациенту
    // курс, которого он не покупал.
    const out = coursePurchases([
      { id: 5, date: "2026-08-17T12:00:00+0400", amount: 5000, client: { id: 7 } },
      { id: 6, date: "2026-08-17T12:00:00+0400", amount: 5000, client: { id: 7 }, sold_item_type: null },
    ]);
    expect(out).toEqual([]);
  });

  it("оплата конкретного приёма продажей курса не считается", () => {
    // Её стоимость уже стоит в записи: посчитать здесь — удвоить деньги.
    const out = coursePurchases([
      {
        date: "2026-08-17T12:00:00+0400",
        amount: 5000,
        client: { id: 7 },
        sold_item_type: "goods_transaction",
        record_id: 1911624918,
        visit_id: 1667141067,
      },
    ]);
    expect(out).toEqual([]);
  });

  it("разные покупки одного клиента не склеиваются", () => {
    const out = coursePurchases([
      { id: 1, date: "2026-06-01T10:00:00+0400", amount: 28000, client: { id: 7 }, sold_item_id: 1, sold_item_type: "goods_transaction" },
      { id: 2, date: "2026-08-01T10:00:00+0400", amount: 28000, client: { id: 7 }, sold_item_id: 2, sold_item_type: "goods_transaction" },
    ]);
    expect(out).toHaveLength(2);
  });

  it("без номера продажи склеиваем по клиенту и минуте", () => {
    const out = coursePurchases([
      { id: 1, date: "2026-06-01T10:00:30+0400", amount: 13000, client: { id: 7 }, sold_item_type: "goods_transaction" },
      { id: 2, date: "2026-06-01T10:00:50+0400", amount: 15000, client: { id: 7 }, sold_item_type: "goods_transaction" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(28000);
  });

  it("днём продажи считаем самую раннюю строку покупки", () => {
    const out = coursePurchases([
      { id: 1, date: "2026-08-17T13:00:00+0400", amount: 15000, client: { id: 7 }, sold_item_id: 9, sold_item_type: "goods_transaction" },
      { id: 2, date: "2026-08-17T12:51:00+0400", amount: 13000, client: { id: 7 }, sold_item_id: 9, sold_item_type: "goods_transaction" },
    ]);
    expect(out[0].at.toISOString()).toBe(new Date("2026-08-17T12:51:00+0400").toISOString());
  });

  it("битая дата не роняет разбор", () => {
    expect(
      coursePurchases([
        { id: 1, date: "не дата", amount: 28000, client: { id: 7 }, sold_item_type: "goods_transaction" },
      ]),
    ).toEqual([]);
  });

  it("пусто на входе — пусто на выходе", () => {
    expect(coursePurchases([])).toEqual([]);
  });
});

describe("возврат за курс", () => {
  it("вернули всю сумму — покупки нет", () => {
    const out = coursePurchases([
      ...SALE,
      {
        id: 90,
        date: "2026-08-20T10:00:00+0400",
        amount: -28000,
        client: { id: 363033680 },
        sold_item_id: 1815455376,
        sold_item_type: "goods_transaction",
      },
    ]);
    expect(out).toEqual([]);
  });

  it("вернули часть — остаётся остаток", () => {
    const out = coursePurchases([
      ...SALE,
      {
        id: 91,
        date: "2026-08-20T10:00:00+0400",
        amount: -8000,
        client: { id: 363033680 },
        sold_item_id: 1815455376,
        sold_item_type: "goods_transaction",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(20000);
  });

  it("возврат по чужой продаже покупку не трогает", () => {
    const out = coursePurchases([
      ...SALE,
      {
        id: 92,
        date: "2026-08-20T10:00:00+0400",
        amount: -28000,
        client: { id: 363033680 },
        sold_item_id: 777,
        sold_item_type: "goods_transaction",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(28000);
  });
});
