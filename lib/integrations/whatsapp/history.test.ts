import { describe, expect, it } from "vitest";
import { parseHistory } from "./green-api";

/**
 * История чата — единственный источник контекста, которого у нас нет.
 *
 * Пациент продолжает разговор, начатый до подключения платформы, и если разбор
 * потеряет сообщения или перепутает, кто их писал, агент ответит человеку как
 * незнакомому. Формат у провайдера разный для простого текста, цитаты и
 * подписи к файлу, поэтому проверяем каждый.
 */
describe("parseHistory", () => {
  it("различает сообщения пациента и клиники", () => {
    const rows = parseHistory([
      { idMessage: "a", type: "incoming", timestamp: 1700000000, textMessage: "Здравствуйте" },
      { idMessage: "b", type: "outgoing", timestamp: 1700000060, textMessage: "Добрый день" },
    ]);
    expect(rows.map((r) => [r.direction, r.text])).toEqual([
      ["IN", "Здравствуйте"],
      ["OUT", "Добрый день"],
    ]);
  });

  it("читает текст цитаты и подпись к файлу", () => {
    const rows = parseHistory([
      { idMessage: "a", type: "incoming", timestamp: 1, extendedTextMessage: { text: "ответ на сообщение" } },
      { idMessage: "b", type: "incoming", timestamp: 2, extendedTextMessageData: { text: "ссылка" } },
      { idMessage: "c", type: "incoming", timestamp: 3, caption: "фото анализа" },
    ]);
    expect(rows.map((r) => r.text)).toEqual(["ответ на сообщение", "ссылка", "фото анализа"]);
  });

  it("помечает нетекстовое сообщение, но не теряет его", () => {
    const rows = parseHistory([
      { idMessage: "a", type: "incoming", timestamp: 1, typeMessage: "imageMessage" },
    ]);
    // Содержимое нам недоступно, но факт обмена важен для понимания разговора.
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("[imageMessage]");
  });

  it("пропускает строки без идентификатора, времени и содержимого", () => {
    expect(
      parseHistory([
        { type: "incoming", timestamp: 1, textMessage: "без id" },
        { idMessage: "b", textMessage: "без времени" },
        { idMessage: "c", type: "incoming", timestamp: 1, textMessage: "   " },
        null,
      ]),
    ).toEqual([]);
  });

  it("возвращает переписку от старых сообщений к новым", () => {
    // Провайдер отдаёт историю в обратном порядке; в переписку она должна лечь
    // так же, как её читает человек.
    const rows = parseHistory([
      { idMessage: "new", type: "incoming", timestamp: 200, textMessage: "второе" },
      { idMessage: "old", type: "incoming", timestamp: 100, textMessage: "первое" },
    ]);
    expect(rows.map((r) => r.text)).toEqual(["первое", "второе"]);
    expect(rows[0].at.getTime()).toBe(100_000);
  });
});
