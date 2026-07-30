import { z } from "zod";

/**
 * Вебхуки YCLIENTS: изменения записей/клиентов/услуг прилетают сюда и обновляют
 * локальную проекцию (§2). Вход валидируется zod (§11). Идемпотентность — на
 * уровне upsert по yclients*Id: повторная доставка не создаёт дублей.
 */
export const WebhookEventSchema = z.object({
  company_id: z.union([z.number(), z.string()]).optional(),
  resource: z.string(),
  resource_id: z.union([z.number(), z.string()]).optional(),
  status: z.enum(["create", "update", "delete"]).optional(),
  data: z.unknown().optional(),
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/** YCLIENTS может прислать один объект или массив событий. */
export function parseWebhook(raw: unknown): WebhookEvent[] {
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: WebhookEvent[] = [];
  for (const item of arr) {
    const parsed = WebhookEventSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Сверка секрета вебхука с YCLIENTS_WEBHOOK_SECRET. Пустой секрет в окружении
 * означает «не настроен» → доступ закрыт. Сравнение постоянного времени.
 */
export function verifyWebhookSecret(provided: string | null | undefined): boolean {
  const expected = process.env.YCLIENTS_WEBHOOK_SECRET ?? "";
  if (!expected || !provided) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Какую сущность синка затрагивает событие (для точечного догона). */
export function entityForResource(resource: string): "RECORDS" | "CLIENTS" | "SERVICES" | "STAFF" | "RESOURCES" | null {
  switch (resource) {
    case "record":
      return "RECORDS";
    case "client":
      return "CLIENTS";
    case "service":
      return "SERVICES";
    case "staff":
      return "STAFF";
    case "resource":
      return "RESOURCES";
    default:
      return null;
  }
}
