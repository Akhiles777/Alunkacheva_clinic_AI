import crypto from "node:crypto";

/**
 * Какое устройство стоит за строкой User-Agent.
 *
 * Нужно ровно для одного экрана — `/sistem`, где владелец смотрит, кто и с
 * чего работает в платформе. Библиотеку ради этого не тянем: разбор здесь
 * грубый и таким задуман.
 *
 * ЧЕГО БРАУЗЕР НЕ ГОВОРИТ, того здесь нет и быть не может. User-Agent у
 * MacBook Air M2 и у любого другого Mac совпадает дословно —
 * «Macintosh; Intel Mac OS X 10_15_7», и это не устаревшая версия, а
 * намеренно обобщённая строка. То же у всех iPhone: модели в ней нет с 2017
 * года. Поэтому «MacBook Air M2» и «iPhone 13 Pro» отличить от соседнего
 * такого же аппарата НЕЛЬЗЯ, и притворяться, что можно, вреднее, чем сказать
 * прямо: подпись на экране обещала бы точность, которой нет.
 *
 * Что различить можно: вид аппарата (компьютер, телефон, планшет), систему,
 * браузер и то, что это ТОТ ЖЕ браузер на том же аппарате, что и в прошлый
 * раз, — по отпечатку.
 */

export interface DeviceInfo {
  /** Устойчивый ключ «тот же браузер на том же аппарате». */
  fingerprint: string;
  /** Короткая подпись для экрана: «Mac · Safari». */
  label: string;
  platform: string;
  browser: string;
  kind: "desktop" | "mobile" | "tablet" | "unknown";
}

/**
 * Отпечаток — хэш нормализованной строки.
 *
 * Нормализуем номер версии браузера: он меняется при каждом обновлении, и без
 * этого один и тот же ноутбук превращался бы в новое устройство каждые пару
 * недель — список превратился бы в мусор, а «новое устройство в системе»
 * перестало бы что-либо значить.
 *
 * Хэш, а не сама строка: это ключ, а не сведения. Сам User-Agent хранится
 * рядом целиком — он и так уже лежит в журнале аудита.
 */
export function deviceFingerprint(userAgent: string): string {
  const normalized = userAgent
    .toLowerCase()
    // номера версий → «0»: «chrome/131.0.6778.86» и «chrome/132.0.1» — один браузер
    .replace(/\d+([._]\d+)*/g, "0")
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

const PLATFORMS: [RegExp, string][] = [
  [/iphone/i, "iPhone"],
  [/ipad/i, "iPad"],
  [/android/i, "Android"],
  [/macintosh|mac os x/i, "Mac"],
  [/windows nt/i, "Windows"],
  [/cros/i, "ChromeOS"],
  [/linux/i, "Linux"],
];

/**
 * Браузер. Порядок важен: почти все притворяются друг другом.
 *
 * Chrome пишет в строке «Safari», Edge пишет «Chrome» и «Safari», Yandex
 * пишет «Chrome». Кто объявлен последним в строке, тот и настоящий, поэтому
 * проверяем от самых «честных» к самым общим.
 */
const BROWSERS: [RegExp, string][] = [
  [/yabrowser/i, "Яндекс"],
  [/edg[ae]?\//i, "Edge"],
  [/opr\/|opera/i, "Opera"],
  [/firefox|fxios/i, "Firefox"],
  [/crios/i, "Chrome"],
  [/chrome|chromium/i, "Chrome"],
  [/safari/i, "Safari"],
];

export function parseDevice(userAgent: string | null | undefined): DeviceInfo {
  const ua = (userAgent ?? "").trim();
  if (!ua) {
    /**
     * Строки нет — это не «неизвестное устройство», а «устройства мы не
     * знаем». Разница на экране существенная: во втором случае искать нечего,
     * потому что действие пришло не из браузера (фоновая задача, вебхук).
     */
    return { fingerprint: "unknown", label: "без устройства", platform: "—", browser: "—", kind: "unknown" };
  }

  const platform = PLATFORMS.find(([re]) => re.test(ua))?.[1] ?? "—";
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? "—";

  const kind: DeviceInfo["kind"] = /ipad|tablet/i.test(ua)
    ? "tablet"
    : /iphone|android.*mobile|mobile safari|windows phone/i.test(ua)
      ? "mobile"
      : /macintosh|windows nt|cros|linux/i.test(ua)
        ? "desktop"
        : "unknown";

  const label = platform === "—" && browser === "—" ? "неизвестное" : `${platform} · ${browser}`;

  return { fingerprint: deviceFingerprint(ua), label, platform, browser, kind };
}

/** Как называется вид аппарата на экране. */
export const KIND_LABEL: Record<DeviceInfo["kind"], string> = {
  desktop: "компьютер",
  mobile: "телефон",
  tablet: "планшет",
  unknown: "неизвестно",
};
