import { describe, expect, it } from "vitest";
import { confusedStreak, stuckInMisunderstanding, uninformative } from "./confusion";
import type { Turn } from "./llm";

const patient = (content: string): Turn => ({ role: "user", content });
const agent = (content: string): Turn => ({ role: "assistant", content });

/**
 * Реплики из прогона сценариев: пациент трижды написал невнятное, агент
 * трижды переспросил, человека не позвал никто.
 */
describe("разговор не двигается", () => {
  it("узнаёт сообщение без содержания", () => {
    for (const t of ["ыыы", "?", "ну так что", "...", "   ", "ок ну"]) {
      expect(uninformative(t), t).toBe(true);
    }
  });

  it("короткий, но осмысленный ответ содержательным считает", () => {
    // «Взрослому» — ответ по делу, обрывать на нём разговор нельзя.
    for (const t of ["Взрослому", "Ребёнку", "8000", "да, взрослый"]) {
      expect(uninformative(t), t).toBe(false);
    }
  });

  it("зовёт человека на третьей неудачной попытке", () => {
    const history = [patient("ыыы"), agent("Чем могу помочь?"), patient("?"), agent("Уточните вопрос")];
    expect(confusedStreak(history, "ну так что")).toBe(3);
    expect(stuckInMisunderstanding(history, "ну так что")).toBe(true);
  });

  it("двух попыток мало", () => {
    const history = [patient("ыыы"), agent("Чем могу помочь?")];
    expect(stuckInMisunderstanding(history, "?")).toBe(false);
  });

  it("осмысленный ответ обнуляет счёт", () => {
    const history = [
      patient("ыыы"),
      agent("Чем могу помочь?"),
      patient("сколько стоит приём"),
      agent("Приём остеопата стоит 8000 ₽."),
    ];
    expect(stuckInMisunderstanding(history, "?")).toBe(false);
  });

  it("уточняющие вопросы при записи разговор не обрывают", () => {
    // «Для взрослого или ребёнка?» → «Взрослому» → «К какому врачу?» — это
    // нормальный ход записи, а не непонимание.
    const history = [
      patient("Хочу записаться"),
      agent("Для взрослого или ребёнка?"),
      patient("Взрослому"),
      agent("К какому врачу?"),
    ];
    expect(stuckInMisunderstanding(history, "К Ирине")).toBe(false);
  });
});
