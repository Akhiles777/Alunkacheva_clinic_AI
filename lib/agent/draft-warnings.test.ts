import { describe, expect, it } from "vitest";
import { draftWarnings, type DraftFacts } from "./draft-warnings";

const facts = (p: Partial<DraftFacts> = {}): DraftFacts => ({
  prices: [
    { title: "Взрослый приём", price: 8000 },
    { title: "БОС-терапия, сеанс", price: 2800 },
  ],
  freeAt: {},
  hasFutureBooking: true,
  knowledgeAnswer: null,
  ...p,
});

describe("подсказки перед отправкой", () => {
  it("цена из прайса вопросов не вызывает", () => {
    expect(draftWarnings("Приём стоит 8000 ₽", facts())).toEqual([]);
    expect(draftWarnings("Сеанс — 2 800 руб", facts())).toEqual([]);
  });

  it("цена мимо прайса — замечаем и показываем прайс", () => {
    const w = draftWarnings("Сделаем за 5000 ₽", facts());
    expect(w[0].kind).toBe("price");
    expect(w[0].suggestion).toContain((8000).toLocaleString("ru-RU"));
  });

  it("занятое время замечаем, свободное — нет", () => {
    const busy = draftWarnings("Приходите в 14:00", facts({ freeAt: { "14:00": false } }));
    expect(busy[0].kind).toBe("time");
    expect(draftWarnings("Приходите в 14:00", facts({ freeAt: { "14:00": true } }))).toEqual([]);
    // Про время, которого мы не знаем, молчим: догадка хуже молчания.
    expect(draftWarnings("Приходите в 19:20", facts())).toEqual([]);
  });

  it("обещание записи без записи — просим проверить", () => {
    const w = draftWarnings("Записала вас на четверг", facts({ hasFutureBooking: false }));
    expect(w[0].kind).toBe("promise");
    // Когда запись есть, обещание правдиво и подсказки нет.
    expect(draftWarnings("Записала вас на четверг", facts())).toEqual([]);
  });

  it("упоминание записи без обещания подсказки не вызывает", () => {
    expect(draftWarnings("Ваша запись в четверг в силе", facts({ hasFutureBooking: false }))).toEqual(
      [],
    );
  });

  it("медицинская тема с готовым ответом клиники", () => {
    const w = draftWarnings("После процедуры может болеть шея, это нормально", {
      ...facts(),
      knowledgeAnswer: {
        topic: "После остеопатии",
        answer: "Лёгкая болезненность 1–2 дня — обычное дело.",
      },
    });
    expect(w[0].kind).toBe("medical");
    expect(w[0].suggestion).toContain("болезненность");
  });

  it("без готового ответа справочника про медицину не напоминаем", () => {
    expect(draftWarnings("Болит шея", facts())).toEqual([]);
  });

  it("пустой и короткий текст не разбираем", () => {
    expect(draftWarnings("", facts())).toEqual([]);
    expect(draftWarnings("да", facts())).toEqual([]);
  });

  it("подсказка ничего не запрещает: это просто список замечаний", () => {
    const w = draftWarnings(
      "Записала вас в 14:00 за 5000 ₽",
      facts({ hasFutureBooking: false, freeAt: { "14:00": false } }),
    );
    expect(w.map((x) => x.kind).sort()).toEqual(["price", "promise", "time"]);
  });
});
