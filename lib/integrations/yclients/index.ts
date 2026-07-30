/**
 * Каркас интеграции YCLIENTS (Этап 1). Публичная поверхность модуля.
 * Всё инертно, пока YCLIENTS_ENABLED !== "true".
 */
export { isYclientsEnabled } from "./config";
export { getYclientsClient, YclientsApiError, YclientsDisabledError } from "./client";
export { loadYclientsCredentials } from "./credentials";
export { syncAll } from "./sync";
export { parseWebhook, verifyWebhookSecret, entityForResource } from "./webhook";
export type { SyncResult } from "./sync";
