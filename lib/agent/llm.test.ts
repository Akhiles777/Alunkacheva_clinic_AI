import { describe, expect, it } from "vitest";
import { offCharacter } from "./llm";

/**
 * Заслон на ответ, вышедший из роли.
 *
 * Найден живым прогоном: на вопрос о беременности модель ответила
 * «I'm Claude, an AI assistant made by Anthropic…» — по делу, но по-английски
 * и от чужого имени. Пациент получил бы сообщение на незнакомом языке и узнал
 * бы, что говорит с моделью.
 */
describe("ответ вне роли", () => {
  it("представился моделью — не отправляем", () => {
    expect(offCharacter("I'm Claude, an AI assistant made by Anthropic.")).toBe(true);
    expect(offCharacter("Как ИИ-ассистент от Anthropic, я не могу советовать.")).toBe(true);
  });

  it("ответ по-английски — не отправляем", () => {
    expect(
      offCharacter("I can't provide medical advice about pregnancy or any health condition."),
    ).toBe(true);
  });

  it("обычный русский ответ проходит", () => {
    expect(
      offCharacter("Приём остеопата у Ирины стоит 8000 ₽ и длится 45 минут. Записью занимается администратор."),
    ).toBe(false);
  });

  /**
   * Латиница внутри русского ответа законна: у клиники есть «IV-терапия» и
   * «BRAINBI». Решает перевес букв, а не их наличие.
   */
  it("названия услуг латиницей ответ не портят", () => {
    expect(offCharacter("Программа IV-ТЕРАПИЯ и БОС + BRAINBI — 2800 ₽ за сеанс, 40 минут.")).toBe(
      false,
    );
  });

  it("пустой ответ — тоже не ответ", () => {
    expect(offCharacter("   ")).toBe(true);
  });

  it("короткая реплика языком не меряется", () => {
    expect(offCharacter("Да, конечно")).toBe(false);
  });
});
