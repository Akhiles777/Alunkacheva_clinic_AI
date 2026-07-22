import { describe, expect, it } from "vitest";
import { formatPhone, isSamePhone, normalizePhone } from "./phone";

describe("normalizePhone", () => {
  it("приводит привычные российские записи к одному E.164", () => {
    const variants = [
      "+7 (999) 123-45-67",
      "8 999 123 45 67",
      "89991234567",
      "9991234567",
      "7 999 123-45-67",
      "  +79991234567  ",
      "тел. 8-999-123-45-67",
    ];

    for (const variant of variants) {
      expect(normalizePhone(variant), variant).toBe("+79991234567");
    }
  });

  it("понимает международный префикс 00", () => {
    expect(normalizePhone("00 49 30 123456")).toBe("+4930123456");
  });

  it("не трогает иностранные номера с плюсом", () => {
    expect(normalizePhone("+49 30 1234567")).toBe("+49301234567");
    expect(normalizePhone("+998 90 123 45 67")).toBe("+998901234567");
  });

  it("не превращает 8 в +7 у иностранного номера с плюсом", () => {
    // +8 — это не российская «восьмёрка», а код зоны.
    expect(normalizePhone("+8123456789")).toBe("+8123456789");
  });

  it("отбраковывает мусор", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone("не телефон")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("+0123456789")).toBeNull();
    expect(normalizePhone("+7999123456789")).toBeNull();
  });

  it("отбраковывает российский номер неверной длины", () => {
    expect(normalizePhone("+7999123456")).toBeNull();
    expect(normalizePhone("799912345678")).toBeNull();
  });

  it("принимает 8-800", () => {
    expect(normalizePhone("8 800 555 35 35")).toBe("+78005553535");
  });

  it("идемпотентен", () => {
    const once = normalizePhone("8 (999) 123-45-67");
    expect(normalizePhone(once)).toBe(once);
  });
});

describe("isSamePhone", () => {
  it("матчит семью на одном номере как один номер", () => {
    // Ребёнок записан на телефон родителя: номер тот же, пациенты разные.
    // Нормализация обязана считать их одним номером — разводить пациентов
    // будет уже логика матчинга, а не эта функция.
    expect(isSamePhone("8 999 123 45 67", "+7 (999) 123-45-67")).toBe(true);
  });

  it("не считает мусор равным мусору", () => {
    expect(isSamePhone("не телефон", "не телефон")).toBe(false);
    expect(isSamePhone(null, null)).toBe(false);
  });
});

describe("formatPhone", () => {
  it("форматирует российский номер для интерфейса", () => {
    expect(formatPhone("+79991234567")).toBe("+7 999 123-45-67");
  });

  it("иностранный отдаёт как есть", () => {
    expect(formatPhone("+493012345678")).toBe("+493012345678");
  });
});
