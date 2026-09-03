import { describe, expect, it } from "vitest";
import { averageCheck, noShowRate, withSourceShares } from "./summary";
/**
 * Одна метрика — одна функция. «Неявки» считались в кабинете владельца от всех
 * незаменённых визитов, а в карточке специалиста — от состоявшихся исходов:
 * два разных числа под одной подписью.
 */
describe("средний чек", () => {
  it("выручка на пришедшего, а не на клиента", () => {
    // Пациент, пришедший трижды, — это три приёма. Считать «на клиента»
    // значит завысить чек втрое: ровно так расходились график и отчёт.
    expect(averageCheck(24000, 3)).toBe(8000);
  });

  it("никто не пришёл — ноль", () => {
    expect(averageCheck(0, 0)).toBe(0);
  });
});

describe("доля неявок", () => {
  it("знаменатель — только состоявшиеся исходы", () => {
    // 8 пришли, 2 не пришли → 20%. Запланированные на будущее в счёт не идут:
    // неявкой они ещё быть не могли.
    expect(noShowRate(8, 2)).toBe(20);
  });

  it("исходов не было — ноль, а не деление на ноль", () => {
    expect(noShowRate(0, 0)).toBe(0);
  });

  it("все не пришли — сто процентов", () => {
    expect(noShowRate(0, 3)).toBe(100);
  });
});

describe("разрез по источникам", () => {
  const rows = [
    { code: "telegram", title: "Telegram", inquiries: 3, booked: 3 },
    { code: "none", title: "Источник неизвестен", inquiries: 0, booked: 720, unknown: true },
    { code: "whatsapp", title: "WhatsApp", inquiries: 42, booked: 14 },
  ];

  it("известные источники — по убыванию обращений", () => {
    expect(withSourceShares(rows).map((r) => r.code)).toEqual(["whatsapp", "telegram", "none"]);
  });

  /**
   * «Неизвестен» — не источник, а признание незнания. Прыгая по списку в
   * зависимости от числа обращений, строка читалась бы как ещё один канал.
   */
  it("строка «неизвестен» всегда последняя, даже с большим числом обращений", () => {
    const loud = [
      { code: "none", title: "Источник неизвестен", inquiries: 900, booked: 720, unknown: true },
      { code: "whatsapp", title: "WhatsApp", inquiries: 42, booked: 14 },
    ];
    expect(withSourceShares(loud).map((r) => r.code)).toEqual(["whatsapp", "none"]);
  });

  it("строку «неизвестен» не выбрасывает: 720 записей — это величина", () => {
    const out = withSourceShares(rows);
    expect(out.find((r) => r.unknown)?.booked).toBe(720);
  });
});
