/**
 * Проверка формы ключей VAPID.
 *
 * Ключи задаются вручную в настройках хостинга, и перепутать поля легко: на
 * боевом стенде открытый ключ оказался записан и в VAPID_SUBJECT, и в
 * VAPID_PRIVATE. Библиотека web-push в таком случае отказывается работать
 * целиком — не уходит ни одно уведомление, включая проверочное.
 *
 * Размеры заданы стандартом (RFC 8292): открытый ключ — несжатая точка кривой
 * P-256, 65 байт; закрытый — скаляр, 32 байта. Кодировка — base64url.
 */

/** Длина ключа в байтах после декодирования. null — строка не base64url. */
export function keyBytes(value: string | undefined): number | null {
  if (!value) return null;
  const raw = value.trim();
  if (!/^[A-Za-z0-9_-]+=*$/.test(raw)) return null;
  try {
    return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").length;
  } catch {
    return null;
  }
}

export interface KeyCheck {
  ok: boolean;
  /** Готовая к показу строка: что не так и чего ждали. */
  note: string;
}

export function checkVapidKeys(pub: string | undefined, priv: string | undefined): KeyCheck {
  const pubBytes = keyBytes(pub);
  const privBytes = keyBytes(priv);
  const problems: string[] = [];

  if (!pub) problems.push("VAPID_PUBLIC не задан");
  else if (pubBytes !== 65) {
    problems.push(
      `VAPID_PUBLIC — ${pubBytes === null ? "не base64url" : `${pubBytes} байт`}, ожидается 65`,
    );
  }

  if (!priv) problems.push("VAPID_PRIVATE не задан");
  else if (privBytes !== 32) {
    problems.push(
      `VAPID_PRIVATE — ${privBytes === null ? "не base64url" : `${privBytes} байт`}, ожидается 32` +
        (privBytes === 65 ? " (похоже, туда записан открытый ключ)" : ""),
    );
  }

  return problems.length === 0
    ? { ok: true, note: "открытый 65 байт, закрытый 32 байта — верно" }
    : { ok: false, note: problems.join("; ") };
}
