/**
 * Конфигурация интеграции YCLIENTS (Этап 1). Каркас: код готов, но выключен —
 * `YCLIENTS_ENABLED` по умолчанию false, живых вызовов нет, пока не подключим.
 *
 * YCLIENTS — источник истины по расписанию, записям и выручке (§2). Локальные
 * Appointment/Service/Staff/Room/Patient — проекция, наполняется отсюда:
 * начальной выгрузкой + вебхуками. Свой второй источник истины не держим.
 */
export const YCLIENTS_BASE_URL =
  process.env.YCLIENTS_BASE_URL?.replace(/\/+$/, "") || "https://api.yclients.com/api/v1";

/** Медиатип v2 обязателен для актуального формата ответов YCLIENTS. */
export const YCLIENTS_ACCEPT = "application/vnd.yclients.v2+json";

/** Глобальный рубильник интеграции. Пока не подключаем — держим выключенным. */
export function isYclientsEnabled(): boolean {
  return process.env.YCLIENTS_ENABLED === "true";
}

/**
 * Ограничение частоты запросов к API. Все вызовы идут через единый клиент с
 * очередью — прямые fetch из бизнес-логики запрещены (§5). Значения
 * консервативные; уточним по факту лимитов партнёрского доступа.
 */
export const RATE_LIMIT = {
  /** Минимальный интервал между запросами, мс. */
  minIntervalMs: Number(process.env.YCLIENTS_MIN_INTERVAL_MS ?? 250),
  /** Сколько раз повторять при 429/5xx. */
  maxRetries: Number(process.env.YCLIENTS_MAX_RETRIES ?? 4),
  /** База экспоненциальной задержки, мс: delay = baseDelayMs * 2^attempt. */
  baseDelayMs: Number(process.env.YCLIENTS_RETRY_BASE_MS ?? 500),
} as const;

/** Пути API. company_id подставляется из кредов на месте вызова. */
/**
 * На сколько лет назад забираем историю при первой выгрузке. Без неё метрики
 * «новые пациенты» и «первичный/повторный» врут весь первый месяц (§5).
 */
export const HISTORY_YEARS = Number(process.env.YCLIENTS_HISTORY_YEARS ?? 2);

export const ENDPOINTS = {
  services: (companyId: string) => `/company/${companyId}/services`,
  staff: (companyId: string) => `/company/${companyId}/staff`,
  /**
   * Кабинеты (ресурсы).
   *
   * Путь именно такой, а не /company/{id}/resources: последний у YCLIENTS не
   * существует и отвечает 404. Проверено на их API — несуществующий адрес
   * даёт 404 «Произошла ошибка», существующий без пользовательского токена —
   * 401 «Не указан идентификатор пользователя».
   */
  resources: (companyId: string) => `/resources/${companyId}`,
  /** Записи (приёмы) за период. */
  records: (companyId: string) => `/records/${companyId}`,
  /** Одна запись: изменение и удаление при переносе и отмене у нас. */
  record: (companyId: string, recordId: number) => `/record/${companyId}/${recordId}`,
  /**
   * Клиенты филиала (постранично).
   *
   * Только POST: на GET этот адрес отвечает 405 Method Not Allowed. Страница
   * и размер передаются в теле, а не в query.
   */
  clients: (companyId: string) => `/company/${companyId}/clients/search`,
  /** Финансовые транзакции (выручка). */
  transactions: (companyId: string) => `/transactions/${companyId}`,
} as const;
