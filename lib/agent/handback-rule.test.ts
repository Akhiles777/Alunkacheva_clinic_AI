import { describe, expect, it } from "vitest";
import { shouldHandBack, shouldRemind, MAX_REMINDERS } from "./handback-rule";

const NOW = new Date("2026-08-19T15:00:00+03:00");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const HOUR = 60;

describe("возврат диалога агенту через сутки", () => {
  it("сутки тишины — забирает агент", () => {
    expect(shouldHandBack({ createdAt: ago(24 * HOUR + 1) }, NOW)).toBe(true);
  });

  it("двадцать три часа — ещё рано", () => {
    expect(shouldHandBack({ createdAt: ago(23 * HOUR) }, NOW)).toBe(false);
  });

  it("считаем от последнего сообщения, чьим бы оно ни было", () => {
    // Сотрудник ответил вчера и разговор затих — это тоже конец разговора.
    expect(shouldHandBack({ createdAt: ago(30 * HOUR) }, NOW)).toBe(true);
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

  it("после суток не напоминаем: диалог забирает агент", () => {
    expect(shouldRemind({ last: waiting(25 * HOUR), remindedAt: null }, NOW)).toBe(false);
  });
});
