/**
 * Instagram Direct через Meta Graph API (Instagram Messaging).
 *
 * Что здесь важно знать до подключения — эти ограничения не наши, они у Meta,
 * и обойти их нельзя:
 *
 *   1. Нужен аккаунт Instagram Business, привязанный к странице Facebook, и
 *      приложение, прошедшее review с правами на переписку. Без review
 *      сообщения приходят только от тестовых пользователей.
 *   2. **Окно 24 часа.** Ответить пациенту можно только в течение суток с его
 *      последнего сообщения. Позже — отказ от API, и он выглядит как «бот
 *      молчит». Поэтому окно проверяется до отправки, а не по факту ошибки.
 *   3. Телефона в Instagram нет вовсе. Пациент опознаётся по идентификатору
 *      переписки, а карточка заводится, только когда он оставит номер сам.
 *      В WhatsApp номер известен сразу — здесь так не будет.
 */

/** Провайдер в таблице Credential — той же строкой, что пишет раздел «Интеграции». */
export const INSTAGRAM_PROVIDER = "instagram";

/** Версия Graph API — часть пути, а не адреса: прокси пробрасывает путь как есть. */
export const GRAPH_VERSION = "v21.0";

/**
 * Куда ходят запросы к Instagram API.
 *
 * Адреса Meta в коде нет намеренно. С российского сервера graph.instagram.com
 * не открывается, и запросы идут через наш прокси на Vercel
 * (`https://…vercel.app/api/graph`, docs/INSTAGRAM-PROXY.md). Зашитый адрес
 * Meta по умолчанию означал бы, что забытая переменная выглядит как «Instagram
 * не отвечает», а не как «не настроено».
 */
export function graphBase(): string | null {
  const raw = process.env.INSTAGRAM_GRAPH_BASE?.trim().replace(/\/+$/, "");
  return raw || null;
}

/** Полный адрес метода Graph API: `graphUrl("me/messages")`. */
export function graphUrl(path: string): string | null {
  const base = graphBase();
  return base ? `${base}/${GRAPH_VERSION}/${path.replace(/^\/+/, "")}` : null;
}

/** Общий секрет с прокси: им подписан каждый наш запрос и каждое событие от него. */
export function proxySecret(): string {
  return process.env.INSTAGRAM_PROXY_SECRET?.trim() ?? "";
}

/** Заголовок, без которого прокси не пропустит запрос к Meta. */
export const PROXY_SECRET_HEADER = "X-Proxy-Secret";

/** Метка собственных ответов прокси — чтобы отличать его отказ от ответа Meta. */
export const PROXY_OWN_HEADER = "x-ig-proxy";

/**
 * Адрес вебхука на прокси — его вставляют в кабинете Meta.
 *
 * Выводится из INSTAGRAM_GRAPH_BASE: прокси один, и второй переменной с тем же
 * хостом однажды разъехаться с первой. Если база указывает прямо на Meta,
 * прокси нет — и адреса тоже.
 */
export function proxyWebhookUrl(): string | null {
  const base = graphBase();
  if (!base) return null;
  try {
    const url = new URL(base);
    if (/(^|\.)(instagram|facebook)\.com$/i.test(url.hostname)) return null;
    return `${url.origin}/api/webhook`;
  } catch {
    return null;
  }
}

/**
 * Рубильник интеграции. Пока выключен, вебхук отвечает отказом и ни одного
 * обращения к Meta не происходит — то же правило, что у YCLIENTS и WhatsApp.
 */
export function isInstagramEnabled(): boolean {
  return process.env.INSTAGRAM_ENABLED === "true";
}

/**
 * Окно ответа: 24 часа с последнего сообщения пациента.
 *
 * Берём с запасом в пять минут: сообщение могло идти до нас несколько секунд,
 * а ответ ещё готовится. Упереться в границу и получить отказ хуже, чем
 * честно сказать администратору, что окно закрылось.
 */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000 - 5 * 60 * 1000;

export function windowOpen(lastPatientMessageAt: Date | null, now: Date = new Date()): boolean {
  if (!lastPatientMessageAt) return false;
  return now.getTime() - lastPatientMessageAt.getTime() < REPLY_WINDOW_MS;
}

/** Ограничение частоты: у Meta свои лимиты, идём заведомо мягче. */
export const RATE_LIMIT = {
  minIntervalMs: Number(process.env.INSTAGRAM_MIN_INTERVAL_MS ?? 300),
  maxRetries: Number(process.env.INSTAGRAM_MAX_RETRIES ?? 3),
  baseDelayMs: Number(process.env.INSTAGRAM_RETRY_BASE_MS ?? 500),
} as const;
