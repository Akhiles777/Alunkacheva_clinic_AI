import { describe, expect, it } from "vitest";
import { shouldHandBack, shouldRemind, HANDBACK_HOURS, MAX_REMINDERS } from "./handback-rule";

const NOW = new Date("2026-08-19T15:00:00+03:00");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const HOUR = 60;

describe("возврат диалога агенту", () => {
  /**
   * Четыре часа — решение заказчика (август 2026). Прежде были сутки, и
   * вечернее обращение ждало агента до следующего вечера.
   *
   * Границы считаем от самой константы: число задаётся в одном месте, и тест
   * не должен требовать правки при его изменении.
   */
  it("тишина дольше срока — забирает агент", () => {
    expect(shouldHandBack({ createdAt: ago(HANDBACK_HOURS * HOUR + 1) }, NOW)).toBe(true);
  });

  it("на минуту раньше срока — ещё рано", () => {
    expect(shouldHandBack({ createdAt: ago(HANDBACK_HOURS * HOUR - 1) }, NOW)).toBe(false);
  });

  it("считаем от последнего сообщения, чьим бы оно ни было", () => {
    // Сотрудник ответил утром и разговор затих — это тоже конец разговора.
    expect(shouldHandBack({ createdAt: ago(HANDBACK_HOURS * HOUR + 60) }, NOW)).toBe(true);
  });

  it("срок — ровно четыре часа", () => {
    expect(HANDBACK_HOURS).toBe(4);
  });

  it("переписки нет — возвращать нечего", () => {
    expect(shouldHandBack(undefined, NOW)).toBe(false);
  });
});

describe("напоминание сотрудникам", () => {
  const waiting = (min: number) => ({ direction: "IN" as const, createdAt: ago(min) });

  it("полчаса без ответа — напоминаем", () => {
    expect(shouldRemind({ last: waiting(31) }, NOW)).toBe(true);
  });

  it("двадцать минут — ещё рано", () => {
    expect(shouldRemind({ last: waiting(20) }, NOW)).toBe(false);
  });

  it("сотрудник ответил — ожидание кончилось", () => {
    expect(shouldRemind({ last: { direction: "OUT", createdAt: ago(90) } }, NOW)).toBe(false);
  });

  it("напоминали только что — второй раз не шлём", () => {
    expect(shouldRemind({ last: waiting(70), remindedAt: ago(10) }, NOW)).toBe(false);
  });

  it("напомнили один раз — второго не будет", () => {
    // Решение заказчика: напоминание — событие, а не фон. Повторы об одном и
    // том же перестают читать, а вместе с ними перестают читать и новые.
    expect(
      shouldRemind({ last: waiting(200), remindedAt: ago(60), reminderCount: MAX_REMINDERS }, NOW),
    ).toBe(false);
  });

  it("новое ожидание — снова одно напоминание", () => {
    // Счётчик сбрасывается любым новым сообщением, иначе он упёрся бы в
    // предел навсегда.
    expect(shouldRemind({ last: waiting(31), remindedAt: null, reminderCount: 0 }, NOW)).toBe(true);
  });

  it("после возврата не напоминаем: диалог забирает агент", () => {
    expect(
      shouldRemind({ last: waiting(HANDBACK_HOURS * HOUR + 60), remindedAt: null }, NOW),
    ).toBe(false);
  });
});
