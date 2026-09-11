import { describe, expect, it } from "vitest";
import { deviceFingerprint, parseDevice } from "./device";

const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const WINDOWS_YANDEX =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 YaBrowser/24.4.0.0 Safari/537.36";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/604.1";

describe("разбор устройства", () => {
  it("узнаёт систему и вид аппарата", () => {
    expect(parseDevice(MAC_SAFARI).platform).toBe("Mac");
    expect(parseDevice(MAC_SAFARI).kind).toBe("desktop");
    expect(parseDevice(IPHONE_SAFARI).platform).toBe("iPhone");
    expect(parseDevice(IPHONE_SAFARI).kind).toBe("mobile");
    expect(parseDevice(IPAD).kind).toBe("tablet");
    expect(parseDevice(ANDROID_CHROME).kind).toBe("mobile");
  });

  it("различает браузеры, которые притворяются друг другом", () => {
    // Chrome пишет в строке «Safari», Яндекс пишет «Chrome».
    expect(parseDevice(MAC_CHROME).browser).toBe("Chrome");
    expect(parseDevice(MAC_SAFARI).browser).toBe("Safari");
    expect(parseDevice(WINDOWS_YANDEX).browser).toBe("Яндекс");
  });

  it("отсутствие строки — это «устройства мы не знаем», а не «неизвестное»", () => {
    // Так выглядят фоновые задачи и вебхуки: браузера за ними нет вовсе.
    expect(parseDevice(null).label).toBe("без устройства");
    expect(parseDevice("").fingerprint).toBe("unknown");
  });
});

describe("отпечаток устройства", () => {
  it("обновление браузера не делает из ноутбука новое устройство", () => {
    const before = deviceFingerprint(MAC_CHROME);
    const after = deviceFingerprint(MAC_CHROME.replace("131.0.0.0", "132.0.6834.83"));
    expect(after).toBe(before);
  });

  it("разные браузеры на одном аппарате — разные устройства", () => {
    expect(deviceFingerprint(MAC_SAFARI)).not.toBe(deviceFingerprint(MAC_CHROME));
  });

  it("разные аппараты — разные отпечатки", () => {
    expect(deviceFingerprint(IPHONE_SAFARI)).not.toBe(deviceFingerprint(ANDROID_CHROME));
  });

  it("сам User-Agent в отпечаток не попадает", () => {
    // Это ключ, а не сведения: строка хранится рядом отдельно и целиком.
    expect(deviceFingerprint(MAC_SAFARI)).toMatch(/^[0-9a-f]{16}$/);
  });
});

/**
 * Главное ограничение, ради которого этот тест и написан.
 *
 * Заказчик просил не учитывать «MacBook Air M2» и «iPhone 13 Pro». Отличить их
 * по строке браузера невозможно: Apple перестала писать модель в User-Agent, и
 * у всех Mac она дословно одна и та же. Исключать надо по отпечатку
 * конкретного устройства, а не по названию модели.
 */
describe("модель аппарата по строке браузера не определяется", () => {
  it("два разных Mac неотличимы", () => {
    const mac2022 = MAC_SAFARI;
    const mac2019 = MAC_SAFARI; // строка у них совпадает дословно
    expect(deviceFingerprint(mac2019)).toBe(deviceFingerprint(mac2022));
    expect(parseDevice(mac2022).label).not.toMatch(/air|pro|m[12]/i);
  });

  it("модели iPhone в строке нет", () => {
    expect(IPHONE_SAFARI).not.toMatch(/13|pro/i);
    expect(parseDevice(IPHONE_SAFARI).label).toBe("iPhone · Safari");
  });
});
