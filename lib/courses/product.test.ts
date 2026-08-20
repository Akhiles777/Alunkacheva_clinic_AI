import { describe, expect, it } from "vitest";
import { coursePriceByService, type ServiceRow } from "./product";

const svc = (
  id: string,
  title: string,
  price: number,
  visits: number,
  sessions: number | null = null,
): ServiceRow => ({ id, title, price, sessions, visits });

describe("цена курса из справочника услуг", () => {
  it("«БОС-терапия, курс» задаёт цену курса для «БОС-терапия»", () => {
    // Живой справочник клиники: сеанс 2 800 ₽, курс 28 000 ₽ за десять.
    const out = coursePriceByService([
      svc("bos", "БОС-терапия", 2800, 694),
      svc("bos-course", "БОС-терапия, курс", 28000, 0, 10),
    ]);
    expect(out.get("bos")).toEqual([{ price: 28000, sessions: 10 }]);
  });

  it("услуга, по которой ходят, карточкой курса не считается", () => {
    // Иначе «Пакет "PRO"» с четырьмя приёмами объявил бы себя ценой чужого курса.
    const out = coursePriceByService([
      svc("bos", "БОС-терапия", 2800, 694),
      svc("bos-course", "БОС-терапия, курс", 28000, 5),
    ]);
    expect(out.size).toBe(0);
  });

  it("самостоятельный «Пакет PRO» ни к чему не привязывается", () => {
    const out = coursePriceByService([
      svc("bos", "БОС-терапия", 2800, 694),
      svc("pro", 'Пакет "PRO"', 10800, 0),
    ]);
    expect(out.size).toBe(0);
  });

  it("без слова «курс» связи нет", () => {
    const out = coursePriceByService([
      svc("bos", "БОС-терапия", 2800, 694),
      svc("kids", "БОС-терапия для детей", 3000, 0),
    ]);
    expect(out.size).toBe(0);
  });

  it("продолжение должно быть отдельным словом", () => {
    const out = coursePriceByService([
      svc("nak", "НАК", 1000, 50),
      svc("nakkurs", "НАКкурс", 10000, 0),
    ]);
    expect(out.size).toBe(0);
  });

  it("обе курсовые карточки остаются: клиника продаёт и малый курс", () => {
    // Оставить одну значило бы не узнавать покупку второго: 11 000 ₽ не
    // дотягивают до половины двадцати восьми тысяч.
    const out = coursePriceByService([
      svc("bos", "БОС-терапия", 2800, 694),
      svc("c4", "БОС-терапия, курс 4", 11000, 0, 4),
      svc("c10", "БОС-терапия, курс 10", 28000, 0, 10),
    ]);
    expect(out.get("bos")).toEqual([
      { price: 28000, sessions: 10 },
      { price: 11000, sessions: 4 },
    ]);
  });

  it("размер курса не указан — берём умолчание", () => {
    const out = coursePriceByService(
      [svc("bos", "БОС-терапия", 2800, 694), svc("c", "БОС-терапия, курс", 28000, 0)],
      12,
    );
    expect(out.get("bos")).toEqual([{ price: 28000, sessions: 12 }]);
  });

  it("две одинаково подходящие основы — не гадаем", () => {
    const out = coursePriceByService([
      svc("a", "БОС-терапия", 2800, 10),
      svc("b", "БОС-терапия", 2600, 12),
      svc("c", "БОС-терапия, курс", 28000, 0),
    ]);
    expect(out.size).toBe(0);
  });

  it("бесплатная карточка ценой курса не станет", () => {
    const out = coursePriceByService([
      svc("bos", "БОС-терапия", 2800, 694),
      svc("c", "БОС-терапия, курс", 0, 0),
    ]);
    expect(out.size).toBe(0);
  });

  it("пустой справочник ничего не ломает", () => {
    expect(coursePriceByService([])).toEqual(new Map());
  });
});
