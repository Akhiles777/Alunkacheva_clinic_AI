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

  it("прошло полчаса с прошлого напоминания — шлём следующее", () => {
    expect(shouldRemind({ last: waiting(70), remindedAt: ago(31), reminderCount: 1 }, NOW)).toBe(true);
  });

  it("больше трёх напоминаний об одном и том же не шлём", () => {
    // Четвёртое перестают читать, а вместе с ним перестают читать и новые.
    expect(
      shouldRemind({ last: waiting(200), remindedAt: ago(60), reminderCount: MAX_REMINDERS }, NOW),
    ).toBe(false);
  });

  it("после суток не напоминаем: диалог забирает агент", () => {
    expect(shouldRemind({ last: waiting(25 * HOUR), remindedAt: null }, NOW)).toBe(false);
  });
});
