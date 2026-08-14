/**
 * WhatsApp через Green API (§5).
 *
 * С Meta Cloud API напрямую не работаем: провайдер держит сессию и даёт один
 * вебхук. Всё, что знает о Green API, собрано в этой папке — смена провайдера
 * должна быть заменой файлов здесь, а не правкой бизнес-логики.
 *
 * Ключи (idInstance, apiTokenInstance) лежат зашифрованными в таблице
 * Credential, как и у YCLIENTS: раздел «Настройки → Интеграции».
 */

/** Провайдер в таблице Credential. Строка в нижнем регистре, как у остальных. */
export const WHATSAPP_PROVIDER = "whatsapp";

export const GREEN_API_BASE =
  process.env.GREEN_API_BASE_URL?.replace(/\/+$/, "") || "https://api.green-api.com";

/**
 * Глобальный рубильник. Пока выключен — ни одного сетевого вызова, вебхук
 * отвечает 503. Так же, как у YCLIENTS: интеграцию включают осознанно.
 */
export function isWhatsappEnabled(): boolean {
  return process.env.WHATSAPP_ENABLED === "true";
}

/**
 * Ограничение частоты. У Green API оно есть, и упереться в него легко при
 * рассылке напоминаний. Значения консервативные — уточним по факту тарифа.
 */
export const RATE_LIMIT = {
  minIntervalMs: Number(process.env.GREEN_API_MIN_INTERVAL_MS ?? 350),
  maxRetries: Number(process.env.GREEN_API_MAX_RETRIES ?? 3),
  baseDelayMs: Number(process.env.GREEN_API_RETRY_BASE_MS ?? 700),
} as const;

/** Пути Green API. Токен идёт в пути, а не в заголовке — так устроен провайдер. */
export const ENDPOINTS = {
  sendMessage: (id: string, token: string) => `/waInstance${id}/sendMessage/${token}`,
  sendFileByUrl: (id: string, token: string) => `/waInstance${id}/sendFileByUrl/${token}`,
  getStateInstance: (id: string, token: string) => `/waInstance${id}/getStateInstance/${token}`,
  getSettings: (id: string, token: string) => `/waInstance${id}/getSettings/${token}`,
  /**
   * История переписки с одним собеседником.
   *
   * Нужна при первом сообщении: до подключения платформы человек мог месяцами
   * переписываться с клиникой на телефоне, и без этой истории ассистент
   * начинает разговор с чистого листа при живой переписке на экране у
   * пациента.
   */
  getChatHistory: (id: string, token: string) => `/waInstance${id}/getChatHistory/${token}`,
} as const;

/**
 * Состояния инстанса. Отправлять можно только из authorized; остальные —
 * повод сказать человеку, что именно не так, а не молча не доставить.
 */
export const STATE_HINT: Record<string, string> = {
  authorized: "подключено",
  notAuthorized: "номер не привязан — отсканируйте QR в личном кабинете Green API",
  blocked: "инстанс заблокирован провайдером",
  sleepMode: "телефон долго не выходил на связь",
  starting: "инстанс запускается, подождите",
  yellowCard: "провайдер ограничил отправку за подозрительную активность",
};
