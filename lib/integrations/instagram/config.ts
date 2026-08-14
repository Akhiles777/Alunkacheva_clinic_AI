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

export const GRAPH_BASE_URL =
  process.env.INSTAGRAM_GRAPH_URL?.replace(/\/+$/, "") || "https://graph.instagram.com/v21.0";

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
