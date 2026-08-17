import { describe, expect, it } from "vitest";
import { isAcknowledgement, isFarewell, isThanks, smallTalkReply } from "./smalltalk";

/**
 * «Хорошо» — подтверждение, а не вопрос. На боевом стенде такое «Хорошо» ушло
 * в модель, та промолчала, и сработал запасной путь: «Секунду, передаю ваш
 * вопрос администратору». Администратора позвали на слово «хорошо».
 */
describe("вежливые реплики", () => {
  it("узнаёт подтверждение", () => {
    for (const t of ["Хорошо", "ок", "Окей", "Понятно", "Ясно", "Ага", "Договорились"]) {
      expect(isAcknowledgement(t), t).toBe(true);
    }
  });

  it("узнаёт благодарность и прощание", () => {
    expect(isThanks("Спасибо большое!")).toBe(true);
    expect(isThanks("спс")).toBe(true);
    expect(isFarewell("До свидания")).toBe(true);
    expect(isFarewell("Всего доброго")).toBe(true);
  });

  it("отвечает сам и не зовёт человека", () => {
    expect(smallTalkReply("Хорошо")).toBeTruthy();
    expect(smallTalkReply("Спасибо")).toBeTruthy();
    expect(smallTalkReply("До свидания")).toBeTruthy();
  });

  it("вопрос вежливостью не считает", () => {
    for (const t of [
      "Сколько стоит приём?",
      "Хорошо, а во сколько?",
      "Спасибо, а когда можно прийти?",
      "Понятно, а детский приём сколько?",
    ]) {
      expect(smallTalkReply(t), t).toBeNull();
    }
  });

  it("«да» вежливостью не считает", () => {
    // Это ответ на вопрос агента («приём для взрослого?»), и обрывать на нём
    // разговор нельзя.
    expect(smallTalkReply("Да")).toBeNull();
    expect(smallTalkReply("да, взрослому")).toBeNull();
  });

  it("не предлагает помощь после «хорошо»", () => {
    // «Чем ещё могу помочь?» после подтверждения выглядит навязчиво.
    expect(smallTalkReply("Хорошо")).not.toMatch(/чем.*помочь/i);
  });
});
