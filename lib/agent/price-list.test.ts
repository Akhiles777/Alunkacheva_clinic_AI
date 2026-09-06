import { describe, expect, it } from "vitest";
import { patientServices, priceLine, priceListText, PRICE_LIST_LIMIT, dedupeServices } from "./price-list";

const s = (title: string, price: number, durationMin = 0) => ({ title, price, durationMin });

describe("что показываем пациенту", () => {
  /**
   * Живой список клиники: заготовки с нулём и рублём стояли вперемешку с
   * настоящими услугами, и человек, спросивший цену, получал их все.
   */
  it("заготовки с нулевой и рублёвой ценой не показываем", () => {
    const out = patientServices([
      s("Название", 0),
      s("IV-ТЕРАПИЯ", 1),
      s("Сдача анализов", 1),
      s("Повторный прием невролога", 0),
      s("Остеопатия, приём Ирины", 8000, 45),
    ]);
    expect(out.map((x) => x.title)).toEqual(["Остеопатия, приём Ирины"]);
  });

  it("служебные приёмы сотрудникам не показываем", () => {
    const out = patientServices([s("БОС/персонал", 2800), s("Лотос (для персонала)", 700), s("БОС-терапия", 2800)]);
    expect(out.map((x) => x.title)).toEqual(["БОС-терапия"]);
  });
});

describe("строка прайса", () => {
  it("длительность печатаем, только если она заведена", () => {
    expect(priceLine(s("БОС-терапия", 2800, 0))).toBe("• БОС-терапия — 2800 ₽");
    expect(priceLine(s("Остеопатия", 8000, 45))).toBe("• Остеопатия — 8000 ₽, 45 мин");
  });
});

describe("ответ на «услуги и цены»", () => {
  it("длинный список обрезаем и предлагаем спросить конкретную услугу", () => {
    const many = Array.from({ length: PRICE_LIST_LIMIT + 7 }, (_, i) => s(`Услуга ${i}`, 1000));
    const text = priceListText(many)!;
    expect(text.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(PRICE_LIST_LIMIT);
    expect(text).toContain("Есть ещё 7 услуг");
  });

  it("короткий список показываем целиком", () => {
    const text = priceListText([s("БОС-терапия", 2800), s("Остеопатия", 8000, 45)])!;
    expect(text).toContain("БОС-терапия");
    expect(text).toContain("Остеопатия");
    expect(text).not.toContain("Есть ещё");
  });

  it("цен нет вовсе — не отправляем пустое сообщение", () => {
    expect(priceListText([s("Название", 0)])).toBeNull();
  });
});

/**
 * Настоящие дубли справочника клиники: та же услуга, та же цена, разное
 * написание. Пациент видит две одинаковые строки подряд и решает, что
 * платформа сломалась.
 */
describe("дубли услуг пациенту не показываем", () => {
  it("слипаются одинаковые по цене названия-близнецы", () => {
    const out = dedupeServices([
      { title: "Внутривенное капельное введение растворов", price: 500, durationMin: 60 },
      { title: "Внутривенное капельное введение растворов (IV-терапия)", price: 500, durationMin: 60 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Внутривенное капельное введение растворов");
  });

  it("сеанс и курс — разные услуги, их не слить", () => {
    const out = dedupeServices([
      { title: "БОС-терапия", price: 2800, durationMin: 40 },
      { title: "БОС-терапия, курс", price: 28000, durationMin: 40 },
    ]);
    expect(out).toHaveLength(2);
  });

  it("разные услуги с одинаковой ценой остаются обе", () => {
    const out = dedupeServices([
      { title: "Взрослый прием - остеопатия", price: 8000, durationMin: 45 },
      { title: "Остеопатия для беременных", price: 8000, durationMin: 45 },
    ]);
    expect(out).toHaveLength(2);
  });
});
