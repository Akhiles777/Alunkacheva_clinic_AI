import { describe, expect, it } from "vitest";
import { deviceLabel, osVersion } from "./user-agent";

/**
 * Строки взяты из боевого журнала: именно на них прежний определитель показал
 * «Safari · iPhone» и «Chrome · Windows» вместо Яндекс.Браузера.
 */
const YA_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 YaBrowser/26.6.7.367.10 SA/3 Mobile/15E148 Safari/604.1";
const YA_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 YaBrowser/26.6.0.0 Safari/537.36";
const YA_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 YaBrowser/26.6.0.0 Safari/537.36";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";

describe("deviceLabel", () => {
  it("узнаёт Яндекс.Браузер, а не Safari и Chrome под ним", () => {
    expect(deviceLabel(YA_IPHONE)).toBe("Яндекс.Браузер · iPhone");
    expect(deviceLabel(YA_WINDOWS)).toBe("Яндекс.Браузер · Windows");
    expect(deviceLabel(YA_MAC)).toBe("Яндекс.Браузер · Mac");
  });

  it("не ломает определение обычных браузеров", () => {
    expect(deviceLabel(CHROME_MAC)).toBe("Chrome · Mac");
    expect(deviceLabel(SAFARI_IPHONE)).toBe("Safari · iPhone");
  });

  it("пустая строка не выдумывает устройство", () => {
    expect(deviceLabel(null)).toBe("—");
    expect(deviceLabel("")).toBe("—");
  });
});

describe("osVersion", () => {
  it("достаёт версию системы", () => {
    expect(osVersion(YA_IPHONE)).toBe("iOS 26.5.2");
    expect(osVersion(YA_WINDOWS)).toBe("Windows 10/11");
  });

  it("возвращает null, когда версии в строке нет", () => {
    expect(osVersion(CHROME_MAC)).toBeNull();
    expect(osVersion(null)).toBeNull();
  });
});
