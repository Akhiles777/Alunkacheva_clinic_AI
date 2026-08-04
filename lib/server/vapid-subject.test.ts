import { afterEach, describe, expect, it, vi } from "vitest";
import { vapidSubject } from "./vapid-subject";

/**
 * Контакт отправителя push. Проверка появилась после боевого сбоя: в
 * VAPID_SUBJECT на хостинге оказался открытый ключ вместо адреса, и не
 * уходило ни одно уведомление — ни рабочее, ни проверочное.
 */
describe("vapidSubject", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("берёт корректный mailto из окружения", () => {
    vi.stubEnv("VAPID_SUBJECT", "mailto:push@clinic.ru");
    expect(vapidSubject()).toBe("mailto:push@clinic.ru");
  });

  it("берёт корректный https из окружения", () => {
    vi.stubEnv("VAPID_SUBJECT", "https://clinic.ru/contacts");
    expect(vapidSubject()).toBe("https://clinic.ru/contacts");
  });

  it("подставляет адрес по умолчанию, если вместо адреса записан ключ", () => {
    vi.stubEnv("VAPID_SUBJECT", "BH418GOt5WbuD6NUESc8gtBYl2uE7iXVBLWGOMhW_3YsBc");
    expect(vapidSubject()).toMatch(/^mailto:/);
  });

  it("подставляет адрес по умолчанию для пустого значения и пробелов", () => {
    vi.stubEnv("VAPID_SUBJECT", "   ");
    expect(vapidSubject()).toMatch(/^mailto:/);
  });

  it("не принимает http и адрес без домена", () => {
    vi.stubEnv("VAPID_SUBJECT", "http://clinic.ru");
    expect(vapidSubject()).toMatch(/^mailto:/);
    vi.stubEnv("VAPID_SUBJECT", "mailto:admin");
    expect(vapidSubject()).toMatch(/^mailto:/);
  });
});
