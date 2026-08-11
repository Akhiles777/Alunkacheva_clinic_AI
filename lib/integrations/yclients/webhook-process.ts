import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { getYclientsClient } from "./client";
import { syncResources, syncServices, syncStaff, upsertClient, upsertRecord } from "./sync";
import { entityForResource, type WebhookEvent } from "./webhook";
import type { YclientsClient as YclientsClientDto, YclientsRecord } from "./types";

/**
 * Обработка вебхуков YCLIENTS.
 *
 * Раньше маршрут принимал событие, отвечал «ок» и выбрасывал его: изменения,
 * сделанные администратором в YCLIENTS, до нас не доезжали вообще. При этом
 * YCLIENTS — источник истины по расписанию (§2), то есть расходились не мелочи,
 * а основа.
 *
 * Два принципа:
 *
 *  1. Событие сначала записывается, потом обрабатывается. Упали на обработке —
 *     запись осталась, видно что и почему не прошло.
 *  2. Данные берём из тела события, когда они там есть. Если нет — не гадаем и
 *     не дёргаем API поштучно, а отмечаем сущность как требующую догона: её
 *     подберёт ближайшая инкрементальная синхронизация.
 */

/**
 * Устойчивый идентификатор события.
 *
 * YCLIENTS не присылает собственный id доставки, а повтор при сетевом сбое
 * прилетает тем же телом. Хэш тела даёт то, что нужно: одинаковая доставка —
 * один идентификатор, реальное изменение — другой.
 */
export function eventId(event: WebhookEvent): string {
  const body = JSON.stringify({
    r: event.resource,
    id: event.resource_id ?? null,
    s: event.status ?? null,
    d: event.data ?? null,
  });
  return createHash("sha256").update(body).digest("hex").slice(0, 40);
}

export type ProcessOutcome = "processed" | "duplicate" | "deferred" | "ignored" | "failed";

/**
 * Записать событие и обработать его. Повторная доставка того же события
 * возвращает "duplicate" и ничего не меняет.
 */
export async function handleWebhookEvent(
  companyId: string,
  event: WebhookEvent,
): Promise<ProcessOutcome> {
  const externalEventId = eventId(event);
  const entity = entityForResource(event.resource);

  const created = await prisma.webhookEvent
    .create({
      data: {
        companyId,
        provider: "YCLIENTS",
        externalEventId,
        eventType: `${event.resource}.${event.status ?? "update"}`,
        payload: (event.data ?? {}) as object,
        status: "PENDING",
      },
      select: { id: true },
    })
    .catch(() => null);
  // Уникальный индекс (provider, externalEventId) не дал создать — значит это
  // повтор той же доставки.
  if (!created) return "duplicate";

  if (!entity) {
    // Событие не про наши сущности — фиксируем как пропущенное, а не как сбой.
    await finish(created.id, "SKIPPED");
    return "ignored";
  }

  try {
    const outcome = await apply(companyId, entity, event);
    await finish(created.id, outcome === "deferred" ? "PENDING" : "PROCESSED");
    return outcome;
  } catch (e) {
    await prisma.webhookEvent
      .update({
        where: { id: created.id },
        data: {
          status: "FAILED",
          attempts: { increment: 1 },
          error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
        },
      })
      .catch(() => {});
    return "failed";
  }
}

async function finish(id: string, status: "PROCESSED" | "SKIPPED" | "PENDING"): Promise<void> {
  await prisma.webhookEvent
    .update({
      where: { id },
      data: { status, processedAt: status === "PENDING" ? null : new Date() },
    })
    .catch(() => {});
}

async function apply(
  companyId: string,
  entity: NonNullable<ReturnType<typeof entityForResource>>,
  event: WebhookEvent,
): Promise<ProcessOutcome> {
  // Запись и клиент приходят с телом — применяем точечно, без обращения к API.
  if (entity === "RECORDS") {
    const dto = asRecord(event);
    if (!dto) return deferEntity(companyId, "RECORDS");
    await upsertRecord(companyId, dto);
    return "processed";
  }

  if (entity === "CLIENTS") {
    const dto = asClient(event);
    if (!dto) return deferEntity(companyId, "CLIENTS");
    await upsertClient(companyId, dto);
    return "processed";
  }

  /**
   * Справочники (услуги, персонал, кабинеты) — короткие списки, десятки строк.
   * Перечитать их целиком дешевле и надёжнее, чем разбирать частичное тело
   * события и гадать, какие поля пришли.
   */
  const client = await getYclientsClient(companyId);
  if (!client) return deferEntity(companyId, entity);

  if (entity === "SERVICES") await syncServices(companyId, client);
  if (entity === "STAFF") await syncStaff(companyId, client);
  if (entity === "RESOURCES") await syncResources(companyId, client);
  return "processed";
}

/**
 * Тела события не хватило. Сбрасываем отметку последней синхронизации, чтобы
 * ближайший инкрементальный прогон захватил изменение, — вместо того чтобы
 * выдумывать данные или терять событие.
 */
async function deferEntity(
  companyId: string,
  entity: NonNullable<ReturnType<typeof entityForResource>>,
): Promise<ProcessOutcome> {
  /**
   * Обнуляем отметку последней синхронизации: ближайший инкрементальный прогон
   * тогда пойдёт от полного окна и заведомо захватит это изменение.
   */
  await prisma.syncCursor
    .updateMany({ where: { companyId, entity }, data: { status: "IDLE", lastSyncedAt: null } })
    .catch(() => {});
  return "deferred";
}

/** Тело события — запись, если в нём есть обязательные для проекции поля. */
export function asRecord(event: WebhookEvent): YclientsRecord | null {
  const d = event.data as Partial<YclientsRecord> | undefined;
  if (!d || typeof d !== "object") return null;
  if (typeof d.id !== "number" || typeof d.staff_id !== "number") return null;
  if (typeof d.datetime !== "string") return null;
  return d as YclientsRecord;
}

/** Тело события — клиент. Телефон необязателен: он может быть скрыт настройками. */
export function asClient(event: WebhookEvent): YclientsClientDto | null {
  const d = event.data as Partial<YclientsClientDto> | undefined;
  if (!d || typeof d !== "object") return null;
  if (typeof d.id !== "number") return null;
  return d as YclientsClientDto;
}
