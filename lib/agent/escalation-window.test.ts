import { describe, expect, it } from "vitest";
import { shouldNotifyEscalation } from "./escalation-window";

/**
 * Проверка появилась после боевой жалобы: по кнопке «позвать администратора»
 * push приходил, а та же просьба словами в диалоге с ассистентом не доходила
 * ни до кого. Повторы глушились по статусу диалога, который держится, пока
 * сотрудник не вернёт диалог боту.
 */
const now = new Date("2026-08-04T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

describe("shouldNotifyEscalation", () => {
  it("зовёт человека, если в этом диалоге ещё не звали", () => {
    expect(shouldNotifyEscalation({ reason: "MISUNDERSTOOD", lastEscalatedAt: null, now })).toBe(true);
  });

  it("зовёт по прямой просьбе, даже если диалог уже переводили человеку", () => {
    expect(
      shouldNotifyEscalation({ reason: "PATIENT_REQUEST", lastEscalatedAt: ago(5), now }),
    ).toBe(true);
  });

  it("зовёт по прямой просьбе всегда, даже сразу после предыдущей", () => {
    expect(
      shouldNotifyEscalation({ reason: "PATIENT_REQUEST", lastEscalatedAt: ago(0), now }),
    ).toBe(true);
    expect(
      shouldNotifyEscalation({ reason: "AGENT_REQUEST", lastEscalatedAt: ago(0), now }),
    ).toBe(true);
  });

  it("медицинский вопрос считается прямой просьбой", () => {
    expect(
      shouldNotifyEscalation({ reason: "MEDICAL_QUESTION", lastEscalatedAt: ago(5), now }),
    ).toBe(true);
  });

  it("решение агента не повторяется чаще раза в четверть часа", () => {
    expect(shouldNotifyEscalation({ reason: "KEYWORD", lastEscalatedAt: ago(5), now })).toBe(false);
    expect(shouldNotifyEscalation({ reason: "KEYWORD", lastEscalatedAt: ago(20), now })).toBe(true);
  });

  it("сбитые часы не приводят к вечной тишине", () => {
    const future = new Date(now.getTime() + 60 * 60_000);
    expect(
      shouldNotifyEscalation({ reason: "MISUNDERSTOOD", lastEscalatedAt: future, now }),
    ).toBe(true);
  });
});
