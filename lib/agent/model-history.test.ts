import { describe, expect, it } from "vitest";
import { INTAKE_PLACEHOLDER, historyForModel, questionForModel } from "./model-history";

const STAFF = ["Алункачева Ирина Алилгаджиевна", "Мугадова Разият Ризвановна"];

describe("история для внешней модели", () => {
  it("анкета пациента наружу не уходит — только пометка", () => {
    const out = historyForModel(
      [
        { role: "assistant", content: "Пришлите ФИО, возраст и причину обращения." },
        { role: "user", content: "Мамаев Умакай Заурович\n10 лет\nНедержание кала" },
      ],
      STAFF,
    );
    expect(out[1].content).toBe(INTAKE_PLACEHOLDER);
    expect(JSON.stringify(out)).not.toContain("Мамаев");
    expect(JSON.stringify(out)).not.toContain("кала");
  });

  it("обычные реплики и ответы агента не трогаются", () => {
    const turns = [
      { role: "user" as const, content: "Сколько стоит остеопатия?" },
      { role: "assistant" as const, content: "Взрослый приём — 8000 ₽." },
      { role: "user" as const, content: "Взрослый Разият Резванова" },
    ];
    expect(historyForModel(turns, STAFF)).toEqual(turns);
  });
});

describe("текущее сообщение для внешней модели", () => {
  it("из анкеты с вопросом наружу уходит только вопрос", () => {
    const out = questionForModel(
      "Степан Андрей Павлович, 15 лет, 35 кг, город Махачкала, извиняюсь, а у вас же город тоже Махачкала?",
      STAFF,
    );
    expect(out).toContain("а у вас же город тоже Махачкала?");
    expect(out).not.toContain("Степан");
    expect(out).not.toContain("35 кг");
  });

  it("обычный вопрос уходит как есть", () => {
    expect(questionForModel("Сколько стоит приём остеопата?", STAFF)).toBe("Сколько стоит приём остеопата?");
  });
});
