import { describe, expect, it } from "vitest";
import { shouldRetract } from "./late-delivery";
import { STALE_REASON } from "./queue-rule";

const MIN = 60_000;
const created = new Date(Date.UTC(2026, 9, 12, 10, 0));
const at = (min: number) => new Date(created.getTime() + min * MIN);
const bot = { authorType: "BOT", createdAt: created, failureReason: null, repliedBeforeSent: false };

describe("shouldRetract", () => {
  it("ответ агента ушёл вовремя — не трогаем", () => {
    expect(shouldRetract("sent", { ...bot, sentAt: at(0.1) })).toBe(false);
  });

  it("ответ агента ушёл через час после поломки провайдера — удаляем", () => {
    expect(shouldRetract("sent", { ...bot, sentAt: at(60) })).toBe(true);
  });

  it("ушёл через две минуты, а человек уже успел ответить — удаляем", () => {
    expect(shouldRetract("sent", { ...bot, sentAt: at(2), repliedBeforeSent: true })).toBe(true);
  });

  it("времени отправки нет — по опозданию не судим", () => {
    expect(shouldRetract("sent", { ...bot, sentAt: null })).toBe(false);
  });

  it("поздняя доставка — это телефон пациента, а не опоздание отправки", () => {
    expect(shouldRetract("delivered", { ...bot, sentAt: at(60) })).toBe(false);
  });

  it("сообщение администратора не удаляем молча", () => {
    expect(shouldRetract("sent", { ...bot, authorType: "STAFF", sentAt: at(60) })).toBe(false);
  });

  it("снятое из очереди, но всё-таки ушедшее, — удаляем, чьё бы оно ни было", () => {
    expect(shouldRetract("delivered", { ...bot, authorType: "STAFF", failureReason: STALE_REASON, sentAt: null })).toBe(true);
  });

  it("недоставка — удалять нечего", () => {
    expect(shouldRetract("failed", { ...bot, failureReason: STALE_REASON, sentAt: at(60) })).toBe(false);
  });
});
