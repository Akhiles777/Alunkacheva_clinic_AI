import { describe, expect, it } from "vitest";
import { windowIsTrustworthy } from "./vanished";

/**
 * Сверка множеств — единственный способ узнать, что запись в YCLIENTS
 * отменили: оттуда она просто перестаёт приходить. Цена ошибки в обратную
 * сторону огромна: недобранная страница выглядит как массовая отмена и
 * вычистит месяц настоящих визитов.
 */
describe("можно ли верить окну выгрузки", () => {
  it("страницы добраны полностью — можно", () => {
    expect(windowIsTrustworthy({ fetched: 180, totalCount: 180 })).toBe(true);
  });

  it("сервер не сообщил общее число — верим тому, что пришло", () => {
    expect(windowIsTrustworthy({ fetched: 42, totalCount: null })).toBe(true);
  });

  it("добрали не всё — отменять нельзя", () => {
    // Двадцать записей остались за кадром, и каждая выглядит исчезнувшей.
    expect(windowIsTrustworthy({ fetched: 180, totalCount: 200 })).toBe(false);
  });

  it("пустой ответ — сбой провайдера, а не двести отмен разом", () => {
    expect(windowIsTrustworthy({ fetched: 0, totalCount: 0 })).toBe(false);
    expect(windowIsTrustworthy({ fetched: 0, totalCount: null })).toBe(false);
  });

  it("получили больше обещанного — это не повод не доверять", () => {
    expect(windowIsTrustworthy({ fetched: 205, totalCount: 200 })).toBe(true);
  });
});
