import { describe, expect, it } from "vitest";
import { asksRepeatVisit } from "./repeat-visit";
import { asksHowToBook, wantsToBook } from "./triggers";

/**
 * Живой диалог 5 октября: «Я всё-таки хотела бы на повторный приём попасть» —
 * просьба записать к тому же врачу; агент её не узнал и спросил врача.
 */
describe("повторный приём", () => {
  it("узнаётся как просьба записать и как повтор", () => {
    const t = "Я все таки хотела бы на повторный прием попасть";
    expect(asksHowToBook(t)).toBe(true);
    expect(wantsToBook(t)).toBe(true);
    expect(asksRepeatVisit(t)).toBe(true);
  });

  it("другие слова повтора", () => {
    for (const t of ["Хочу снова к остеопату", "Запишите ещё раз, как в прошлый раз", "Хочу к своему врачу", "Хотела продолжить лечение"]) {
      expect(asksRepeatVisit(t), t).toBe(true);
    }
  });

  it("первичный визит повтором не считается", () => {
    for (const t of ["Хочу записаться к остеопату", "Сколько стоит приём?", "Здравствуйте"]) {
      expect(asksRepeatVisit(t), t).toBe(false);
    }
  });
});
