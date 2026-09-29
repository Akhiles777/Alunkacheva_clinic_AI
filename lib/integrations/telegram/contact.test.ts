import { describe, expect, it } from "vitest";
import { ownContactPhone, secretMatches } from "./contact";

describe("номер из контакта Telegram", () => {
  it("свой контакт с кнопки принимается", () => {
    expect(ownContactPhone({ contact: { phone_number: "+79280000001", user_id: 42 }, fromId: 42 })).toEqual({
      phone: "+79280000001",
    });
  });

  it("чужой контакт не привязывает переписку к чужой карточке", () => {
    // Контакт знакомой из записной книжки: user_id — её, не отправителя.
    expect(ownContactPhone({ contact: { phone_number: "+79280000002", user_id: 77 }, fromId: 42 })).toEqual({
      foreign: true,
    });
    // Контакт без аккаунта в Telegram: user_id нет вовсе.
    expect(ownContactPhone({ contact: { phone_number: "+79280000003" }, fromId: 42 })).toEqual({ foreign: true });
    // Отправитель неизвестен — тоже нет.
    expect(ownContactPhone({ contact: { phone_number: "+79280000004", user_id: 42 }, fromId: null })).toEqual({
      foreign: true,
    });
  });

  it("без контакта — ничего", () => {
    expect(ownContactPhone({ contact: null, fromId: 42 })).toBeNull();
  });
});

describe("секрет вебхука Telegram", () => {
  it("совпадение и несовпадение", () => {
    expect(secretMatches("abc123", "abc123")).toBe(true);
    expect(secretMatches("abc124", "abc123")).toBe(false);
    expect(secretMatches(null, "abc123")).toBe(false);
    expect(secretMatches("abc", "abc123")).toBe(false);
  });
});
