import { describe, expect, it } from "vitest";
import { doctorsWord, groupedOffer } from "./offer-text";

describe("цены по врачам", () => {
  it("взрослый и детский под врачом — как пишет администратор", () => {
    const text = groupedOffer([
      { title: "Остеопатия, приём Ирины", price: 8000, durationMin: 45, owner: "Ирина Алилгаджиевна" },
      { title: "Детский прием до 10 л - остеопатия", price: 5000, durationMin: 40, owner: "Ирина Алилгаджиевна" },
      { title: "Остеопатия - дети, прием Разият", price: 4000, durationMin: 40, owner: "Разият Ризвановна" },
      { title: "Остеопатия, прием Разият", price: 5000, durationMin: 45, owner: "Разият Ризвановна" },
    ]);
    expect(text).toBe(
      "• Ирина Алилгаджиевна — взрослый приём 8000 ₽ (45 мин), детский 5000 ₽ (40 мин)\n" +
        "• Разият Ризвановна — взрослый приём 5000 ₽ (45 мин), детский 4000 ₽ (40 мин)",
    );
  });

  it("подписи не различают строки — под врачом названия", () => {
    const text = groupedOffer([
      { title: "БОС-терапия", price: 2800, durationMin: 40, owner: "Омарова Ирина" },
      { title: "БОС-терапия, курс", price: 28000, durationMin: 40, owner: "Омарова Ирина" },
    ]);
    expect(text).toContain("• Омарова Ирина:");
    expect(text).toContain("БОС-терапия, курс — 28000 ₽");
  });

  it("у услуги без взрослого и детского вариантов подписи «взрослый» нет", () => {
    expect(groupedOffer([{ title: "БОС-терапия", price: 2800, durationMin: 40, owner: "Омарова Ирина" }])).toBe(
      "• Омарова Ирина — БОС-терапия 2800 ₽ (40 мин)",
    );
  });

  it("взрослая строка одна, но услуга делится по возрасту — подпись остаётся", () => {
    expect(
      groupedOffer([{ title: "Остеопатия, прием Разият", price: 5000, durationMin: 45, owner: "Разият Ризвановна" }], true),
    ).toBe("• Разият Ризвановна — взрослый приём 5000 ₽ (45 мин)");
  });

  it("строка без врача — как в прайсе", () => {
    expect(groupedOffer([{ title: "Массаж классический", price: 3000, durationMin: 60, owner: null }])).toBe(
      "• Массаж классический — 3000 ₽, 60 мин",
    );
  });

  it("число врачей словами", () => {
    expect(doctorsWord(2)).toBe("два врача");
    expect(doctorsWord(7)).toBe("врачи");
  });
});
