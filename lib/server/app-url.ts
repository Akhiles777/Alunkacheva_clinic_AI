/**
 * Публичный адрес платформы.
 *
 * Нужен там, где ссылку читает не браузер, а человек в мессенджере: путь вида
 * «/policy» в переписке бесполезен. Берём из DOMAIN — той же переменной, что
 * задаёт домен для сборки и для nginx.
 */
export function appUrl(): string | null {
  const raw = process.env.DOMAIN?.trim();
  if (!raw) return null;
  const host = raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host) return null;
  return `https://${host}`;
}

/** Абсолютная ссылка на страницу платформы. Без домена вернёт null. */
export function absoluteUrl(path: string): string | null {
  const base = appUrl();
  if (!base) return null;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
