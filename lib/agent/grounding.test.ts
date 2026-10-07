import { describe, expect, it } from "vitest";
import { numbersIn, ungroundedNumbers, groundedInFacts, ungroundedLinks, withoutUngroundedSentences, ungroundedMoneyTerms, withoutUngroundedMoneyTerms } from "./grounding";

const CONTEXT = [
  "Услуги и цены:",
  "• Приём остеопата — 3 500 ₽, 60 мин",
  "• Массаж спины — 2 000 ₽, 45 мин",
  "",
  "Часы работы:",
  "Пн: 09:00–19:00",
  "Сб: 10:00–15:00",
  "Телефон: +7 928 000-11-22",
].join("\n");

/**
 * Формулировать ответ ассистенту разрешено — иначе он зачитывает справочник,
 * а не отвечает. Придумывать цену и часы работы нельзя: пациент приходит с
 * названной цифрой в руках.
 */
describe("проверка чисел в ответе", () => {
  it("пропускает ответ, где числа взяты из справки", () => {
    expect(groundedInFacts("Приём остеопата стоит 3500 ₽ и длится 60 минут.", CONTEXT)).toBe(true);
  });

  it("не придирается к другой записи того же числа", () => {
    // В справке «3 500», модель пишет «3500» — это одна и та же цена.
    expect(ungroundedNumbers("Это 3500 рублей.", CONTEXT)).toEqual([]);
  });

  it("ловит выдуманную цену", () => {
    expect(ungroundedNumbers("Приём стоит 4200 ₽.", CONTEXT)).toEqual(["4200"]);
    expect(groundedInFacts("Приём стоит 4200 ₽.", CONTEXT)).toBe(false);
  });

  it("ловит выдуманное время работы", () => {
    expect(ungroundedNumbers("Мы работаем до 21:00.", CONTEXT)).toEqual(["21:00"]);
  });

  it("время из справки пропускает", () => {
    expect(groundedInFacts("В субботу с 10:00 до 15:00.", CONTEXT)).toBe(true);
  });

  it("не считает выдумкой обычный счёт", () => {
    // «за 1–2 дня», «первый приём» — это речь, а не факт о клинике. Ложные
    // срабатывания опаснее пропусков: они бракуют нормальные ответы.
    expect(ungroundedNumbers("Приходите за 5 минут до начала, это 1 визит.", CONTEXT)).toEqual([]);
  });

  it("разбирает время и числа по отдельности", () => {
    expect(numbersIn("с 09:00 до 19:00, цена 3 500")).toEqual(["09:00", "19:00", "3500"]);
  });

  it("телефон из справки не считает выдумкой", () => {
    expect(groundedInFacts("Позвоните: +7 928 000-11-22", CONTEXT)).toBe(true);
  });
});

describe("ссылки и почта в ответе", () => {
  const context = "Политика: https://alunkachevaclinic.ru/policy. Сайт alunkachevaclinic.ru, почта info@alunkachevaclinic.ru";

  it("ссылка, которой нет в справке, не проходит", () => {
    for (const answer of [
      "Оплатить можно по ссылке https://pay-clinic.ru/order",
      "Оплата на сайте оплата.рф",
      "Напишите нам на почту help@gmail.com",
      "Подробнее: www.evil.com",
      "Запишитесь через bit.ly/abc",
    ]) {
      expect(ungroundedLinks(answer, context).length, answer).toBeGreaterThan(0);
    }
  });

  it("ссылки клиники из справки проходят", () => {
    for (const answer of [
      "Политика обработки данных: https://alunkachevaclinic.ru/policy",
      "Наш сайт — alunkachevaclinic.ru.",
      "Почта: info@alunkachevaclinic.ru",
      "Страница: https://www.alunkachevaclinic.ru/policy/",
    ]) {
      expect(ungroundedLinks(answer, context), answer).toEqual([]);
    }
  });

  it("обычный текст ссылкой не считается", () => {
    for (const answer of [
      "Приём стоит 5000 ₽, длится 40 мин. Ждём вас!",
      "Работаем с 09:00 до 21:00, т.е. ежедневно кроме воскресенья.",
      "Возьмите с собой снимки и т.д.",
    ]) {
      expect(ungroundedLinks(answer, context), answer).toEqual([]);
    }
  });
});

describe("предложение с числом не из справки", () => {
  it("уходит только оно, верные цены остаются (прогон 4 октября, «за двоих»)", () => {
    const context = "Взрослый прием - остеопатия — 8000 ₽, 45 мин. Детский прием до 10 л - остеопатия — 5000 ₽, 40 мин.";
    const answer =
      "Взрослый приём — 8000 ₽ (45 минут), детский приём до 10 лет — 5000 ₽ (40 минут). Итого за двоих — 13000 ₽. " +
      "Подтверждаете запись на остеопатию для вас и сына?";
    const kept = withoutUngroundedSentences(answer, context);
    expect(kept).toContain("8000 ₽");
    expect(kept).toContain("5000 ₽");
    expect(kept).not.toContain("13000");
    expect(ungroundedNumbers(kept, context)).toEqual([]);
  });
});

describe("денежные условия — только из справки", () => {
  const reference = "Если планы изменились, предупредите нас не позже чем за 3 часа до приёма — тогда мы успеем предложить время другому пациенту.";

  it("придуманная платная отмена убирается, справка остаётся", () => {
    const answer =
      "Если планы изменились, предупредите нас не позже чем за 3 часа до приёма — тогда мы успеем предложить время другому пациенту. Отмена позже этого времени может быть платной, но точные условия уточните у администратора.";
    expect(ungroundedMoneyTerms(answer, reference)).toEqual(["платной"]);
    expect(withoutUngroundedMoneyTerms(answer, reference)).toBe(
      "Если планы изменились, предупредите нас не позже чем за 3 часа до приёма — тогда мы успеем предложить время другому пациенту.",
    );
  });

  it("условие из справки и «бесплатно» не трогаем", () => {
    const ref = "Предоплата 1000 ₽ при записи на курс. Консультация бесплатная? Нет.";
    expect(ungroundedMoneyTerms("При записи на курс нужна предоплата 1000 ₽.", ref)).toEqual([]);
    expect(ungroundedMoneyTerms("Первичная диагностика бесплатно.", reference)).toEqual([]);
  });
});
