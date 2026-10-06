import { describe, expect, it } from "vitest";
import { doctorsWord, groupedOffer, mainKindOf } from "./offer-text";

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

describe("основная услуга — по людям, а не по сеансам", () => {
  const visits = (kind: string, people: number, from = 0) =>
    Array.from({ length: people }, (_, i) => ({ patientId: `${kind}${from + i}`, kind }));

  it("курсы с десятками сеансов не перевешивают остеопатию", () => {
    // Пять человек на БОС по 30 сеансов — пять человек, а не сто пятьдесят приёмов.
    const bos = visits("терап", 5).flatMap((v) => Array.from({ length: 30 }, () => v));
    expect(mainKindOf([...visits("остео", 40), ...bos, ...visits("внутр", 10)], 0.3)).toBe("остео");
  });

  it("ничья и россыпь — основной нет", () => {
    expect(mainKindOf([...visits("остео", 10), ...visits("терап", 10)], 0.3)).toBeNull();
    expect(mainKindOf([...visits("остео", 2), ...visits("терап", 1), ...visits("внутр", 1), ...visits("забор", 1), ...visits("массаж", 1), ...visits("узи", 1), ...visits("кт", 1)], 0.3)).toBeNull();
  });
});
