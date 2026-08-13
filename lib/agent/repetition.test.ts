import { describe, expect, it } from "vitest";
import { alreadyGreeted, alreadySaid } from "./repetition";
import type { Turn } from "./llm";

const bot = (content: string): Turn => ({ role: "assistant", content });
const patient = (content: string): Turn => ({ role: "user", content });

const PRICES =
  "В клинике принимают два врача-остеопата: Алункачева Ирина Алилгаджимовна — взрослый приём 8 000 ₽, " +
  "детский 5 000 ₽; Мугадова Разият Ризвановна — взрослый приём 5 000 ₽.";

describe("повторы бота", () => {
  it("узнаёт дословный повтор", () => {
    expect(alreadySaid([bot(PRICES)], PRICES)).toBe(true);
  });

  it("узнаёт повтор с добавленной припиской", () => {
    // Справочная запись уходит то с подсказкой про специалиста, то без неё:
    // строки уже не равны, а пациент видит тот же текст.
    const withTail = `${PRICES}\n\nЕсли есть особенности здоровья — уточните у специалиста.`;
    expect(alreadySaid([bot(withTail)], PRICES)).toBe(true);
  });

  it("другой ответ повтором не считает", () => {
    expect(alreadySaid([bot(PRICES)], "Мы работаем с понедельника по субботу с 08:00 до 16:00.")).toBe(false);
  });

  it("повтор за пациентом повтором не считается", () => {
    // Пациент вправе переспрашивать теми же словами — это не заедание бота.
    expect(alreadySaid([patient(PRICES)], PRICES)).toBe(false);
  });

  it("короткие подтверждения повторять можно", () => {
    // «Спасибо», «Хорошо» — нормальная речь, запрещать их бессмысленно.
    expect(alreadySaid([bot("Хорошо, передал администратору.")], "Хорошо, передал администратору.")).toBe(false);
  });

  it("пустая история повторов не даёт", () => {
    expect(alreadySaid([], PRICES)).toBe(false);
  });
});

describe("повторное приветствие", () => {
  it("после первой реплики бота здороваться заново нельзя", () => {
    expect(alreadyGreeted([bot("Здравствуйте!"), patient("а цены?")])).toBe(true);
  });

  it("в начале диалога здороваемся", () => {
    expect(alreadyGreeted([])).toBe(false);
    expect(alreadyGreeted([patient("Добрый день")])).toBe(false);
  });
});
