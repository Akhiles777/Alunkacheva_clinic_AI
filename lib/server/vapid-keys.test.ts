import { describe, expect, it } from "vitest";
import { checkVapidKeys, keyBytes } from "./vapid-keys";

/**
 * Проверка появилась после боевого сбоя: в VAPID_PRIVATE на хостинге лежал
 * открытый ключ, и не уходило ни одного уведомления. Ошибка библиотеки
 * («private key should be 32 bytes long») ни на что не указывала.
 */
const VALID_PUBLIC =
  "BPuY1V1t5TkQ9Zs2qLOrXP87hZ6Ymkd82Ns4BI9Zl76kyWb6tJnMaFcqCY5Qa5Zak_sV9BBD-QnMoXxLSGXU7N0";
const VALID_PRIVATE = "Wy7QGoGDMQTWmDt6R7kl9w6azFg8CkN1un7UVufT2bM";

describe("keyBytes", () => {
  it("считает длину base64url", () => {
    expect(keyBytes(VALID_PUBLIC)).toBe(65);
    expect(keyBytes(VALID_PRIVATE)).toBe(32);
  });

  it("отвергает не base64url и пустое значение", () => {
    expect(keyBytes("mailto:admin@clinic.ru")).toBeNull();
    expect(keyBytes(undefined)).toBeNull();
  });
});

describe("checkVapidKeys", () => {
  it("принимает верную пару", () => {
    expect(checkVapidKeys(VALID_PUBLIC, VALID_PRIVATE).ok).toBe(true);
  });

  it("узнаёт открытый ключ, записанный вместо закрытого", () => {
    const res = checkVapidKeys(VALID_PUBLIC, VALID_PUBLIC);
    expect(res.ok).toBe(false);
    expect(res.note).toContain("открытый ключ");
  });

  it("сообщает про незаданные ключи", () => {
    const res = checkVapidKeys(undefined, undefined);
    expect(res.ok).toBe(false);
    expect(res.note).toContain("VAPID_PUBLIC не задан");
    expect(res.note).toContain("VAPID_PRIVATE не задан");
  });

  it("сообщает про обрезанный ключ с его длиной", () => {
    const res = checkVapidKeys(VALID_PUBLIC.slice(0, 40), VALID_PRIVATE);
    expect(res.ok).toBe(false);
    expect(res.note).toMatch(/VAPID_PUBLIC — \d+ байт, ожидается 65/);
  });
});
