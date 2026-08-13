import { describe, expect, it } from "vitest";
import { consentFromText, isGreeting, menuActionFromText, supportsButtons } from "./text-actions";
import { CONSENT_ACCEPT, CONSENT_DECLINE } from "./consent";

describe("согласие словами", () => {
  it("принимает утвердительные ответы", () => {
    for (const t of ["Да", "да!", "Согласна", "согласен", "Принимаю", "ок", "Конечно"]) {
      expect(consentFromText(t), t).toBe(CONSENT_ACCEPT);
    }
  });

  it("принимает отказ", () => {
    for (const t of ["Нет", "не сейчас", "Не согласен", "откажусь", "позже"]) {
      expect(consentFromText(t), t).toBe(CONSENT_DECLINE);
    }
  });

  it("отказ не читается как согласие", () => {
    // «не согласен» содержит «согласен» — порядок проверки решает всё.
    expect(consentFromText("не согласен")).toBe(CONSENT_DECLINE);
    expect(consentFromText("не согласна")).toBe(CONSENT_DECLINE);
  });

  it("обычный вопрос согласием не считается", () => {
    for (const t of ["Сколько стоит приём?", "Здравствуйте", "А где вы находитесь"]) {
      expect(consentFromText(t), t).toBeNull();
    }
  });

  it("ё и регистр не мешают", () => {
    expect(consentFromText("ДА")).toBe(CONSENT_ACCEPT);
  });
});

describe("меню словами", () => {
  it("узнаёт подписи кнопок", () => {
    expect(menuActionFromText("Услуги и цены")).toBe("prices");
    expect(menuActionFromText("адрес")).toBe("address");
    expect(menuActionFromText("Часы работы")).toBe("hours");
    expect(menuActionFromText("Позвать администратора")).toBe("human");
  });

  it("терпит вежливость и знаки", () => {
    expect(menuActionFromText("адрес?")).toBe("address");
    expect(menuActionFromText("цены пожалуйста")).toBe("prices");
  });

  it("развёрнутый вопрос не подменяет ответом из меню", () => {
    // Иначе вместо ответа по справочнику пациент получит сухой прайс-лист.
    expect(menuActionFromText("сколько стоит приём остеопата и есть ли скидки")).toBeNull();
    expect(menuActionFromText("а во сколько вы работаете в субботу, успею после работы")).toBeNull();
  });

  it("короткий вопрос по услуге идёт в справочник, а не в прайс", () => {
    // Найдено на сквозной проверке: «сколько стоит» в списке синонимов
    // перехватывало этот вопрос и выдавало общий прайс вместо ответа про
    // двух конкретных врачей-остеопатов.
    expect(menuActionFromText("Сколько стоит остеопатия?")).toBeNull();
    expect(menuActionFromText("во сколько работаете")).toBeNull();
    expect(menuActionFromText("где вы находитесь")).toBeNull();
  });

  it("пустое и мусор игнорирует", () => {
    expect(menuActionFromText("")).toBeNull();
    expect(menuActionFromText("...")).toBeNull();
  });
});

describe("кнопки по каналам", () => {
  it("в WhatsApp кнопок нет", () => {
    expect(supportsButtons("TELEGRAM")).toBe(true);
    expect(supportsButtons("WHATSAPP")).toBe(false);
  });
});

describe("приветствие", () => {
  it("узнаёт обычные приветствия", () => {
    for (const t of ["Здравствуйте", "добрый день", "Доброе утро!", "Привет", "Салам алейкум", "Ассаламу алейкум"]) {
      expect(isGreeting(t), t).toBe(true);
    }
  });

  it("терпит вежливые довески", () => {
    expect(isGreeting("Здравствуйте!")).toBe(true);
    expect(isGreeting("Добрый день, подскажите пожалуйста")).toBe(true);
  });

  it("приветствие с вопросом — это вопрос", () => {
    // Иначе на «Здравствуйте, сколько стоит приём» уйдёт дежурная фраза
    // вместо ответа, и пациент решит, что его не читают.
    expect(isGreeting("Здравствуйте, а сколько стоит приём?")).toBe(false);
    expect(isGreeting("Добрый день! Хочу записаться")).toBe(false);
    expect(isGreeting("Сколько стоит остеопатия?")).toBe(false);
  });

  it("пустое не приветствие", () => {
    expect(isGreeting("")).toBe(false);
    expect(isGreeting("...")).toBe(false);
  });
});
