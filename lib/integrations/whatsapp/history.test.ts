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

  it("нетекстовое сообщение подписываем по-человечески", () => {
    const rows = parseHistory([
      { idMessage: "a", type: "incoming", timestamp: 1, typeMessage: "imageMessage" },
    ]);
    // «[imageMessage]» — тип провайдера, он в переписке ничего не объясняет.
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("[фотография]");
    // Ссылки нет — вложение остаётся подписью, открывать нечего.
    expect(rows[0].attachments[0].source).toEqual({ provider: "NONE" });
  });

  /**
   * Файлы истории раньше терялись целиком: фотография превращалась в подпись,
   * которую нельзя открыть. Для переписки, которая шла на телефоне до
   * подключения платформы, это половина содержания.
   */
  it("вытаскивает файл из истории — и из корня записи, и из fileMessageData", () => {
    const rows = parseHistory([
      {
        idMessage: "a",
        type: "outgoing",
        timestamp: 1,
        typeMessage: "imageMessage",
        downloadUrl: "https://api.green-api.com/file/a.jpg",
        caption: "вот снимок",
      },
      {
        idMessage: "b",
        type: "incoming",
        timestamp: 2,
        typeMessage: "documentMessage",
        fileMessageData: {
          downloadUrl: "https://api.green-api.com/file/b.pdf",
          fileName: "анализы.pdf",
          mimeType: "application/pdf",
        },
      },
    ]);
    expect(rows[0].attachments[0].source).toEqual({
      provider: "WHATSAPP",
      url: "https://api.green-api.com/file/a.jpg",
    });
    expect(rows[0].text).toBe("[фотография] вот снимок");
    expect(rows[1].attachments[0].fileName).toBe("анализы.pdf");
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
