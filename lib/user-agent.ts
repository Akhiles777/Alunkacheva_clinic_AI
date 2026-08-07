/**
 * Узнаваемое имя устройства из user-agent.
 *
 * Порядок проверок важен и не случаен. Почти все браузеры на движке Chromium
 * оставляют в строке и «Chrome», и «Safari» ради совместимости, поэтому
 * простая проверка «есть Safari → Safari» врёт. Яндекс.Браузер именно так и
 * определялся: вход с Windows показывался как Chrome, вход с iPhone — как
 * Safari, и журнал доступа вводил в заблуждение ровно там, где должен был
 * давать точный ответ.
 *
 * Сначала ищем фирменные метки (YaBrowser, Edg, OPR), потом общие.
 */
export function deviceLabel(agent: string | null | undefined): string {
  if (!agent) return "—";

  const browser = /YaBrowser/i.test(agent)
    ? "Яндекс.Браузер"
    : /Edg\//i.test(agent)
      ? "Edge"
      : /OPR\/|Opera/i.test(agent)
        ? "Opera"
        : /Firefox|FxiOS/i.test(agent)
          ? "Firefox"
          : /Chrome|CriOS/i.test(agent)
            ? "Chrome"
            : /Safari/i.test(agent)
              ? "Safari"
              : "Браузер";

  const os = /iPhone/i.test(agent)
    ? "iPhone"
    : /iPad/i.test(agent)
      ? "iPad"
      : /Android/i.test(agent)
        ? "Android"
        : /Macintosh|Mac OS X/i.test(agent)
          ? "Mac"
          : /Windows/i.test(agent)
            ? "Windows"
            : "";

  return os ? `${browser} · ${os}` : browser;
}

/**
 * Версия системы, если её видно в строке: «iOS 26.5.2», «Windows 10».
 * Показываем рядом с устройством — по ней отличают два одинаковых телефона.
 */
export function osVersion(agent: string | null | undefined): string | null {
  if (!agent) return null;
  const ios = agent.match(/(?:iPhone|CPU) OS (\d+[_\d]*)/i);
  if (ios) return `iOS ${ios[1].replace(/_/g, ".")}`;
  const win = agent.match(/Windows NT ([\d.]+)/i);
  // Windows 10 и 11 обе отдают NT 10.0 — различить их по user-agent нельзя.
  if (win) return win[1] === "10.0" ? "Windows 10/11" : `Windows NT ${win[1]}`;
  const android = agent.match(/Android ([\d.]+)/i);
  if (android) return `Android ${android[1]}`;
  return null;
}
