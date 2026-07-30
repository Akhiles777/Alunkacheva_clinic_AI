import { prisma } from "@/lib/db";
import type { SyncEntity, SyncStatus } from "@/generated/prisma/enums";

/**
 * Курсоры инкрементальной синхронизации (§5). По каждой сущности храним, докуда
 * дошли и чем закончилось. Начальная выгрузка и последующие догоны читают и
 * двигают эти отметки, чтобы не тянуть всё заново.
 */
export async function readCursor(companyId: string, entity: SyncEntity) {
  return prisma.syncCursor.findUnique({
    where: { companyId_entity: { companyId, entity } },
  });
}

export async function markRunning(companyId: string, entity: SyncEntity) {
  await upsertCursor(companyId, entity, { status: "RUNNING", error: null });
}

export async function markOk(companyId: string, entity: SyncEntity, lastCursor?: string | null) {
  await upsertCursor(companyId, entity, {
    status: "OK",
    error: null,
    lastSyncedAt: new Date(),
    ...(lastCursor !== undefined ? { lastCursor } : {}),
  });
}

export async function markFailed(companyId: string, entity: SyncEntity, error: string) {
  await upsertCursor(companyId, entity, { status: "FAILED", error: error.slice(0, 500) });
}

async function upsertCursor(
  companyId: string,
  entity: SyncEntity,
  data: { status?: SyncStatus; error?: string | null; lastSyncedAt?: Date; lastCursor?: string | null },
) {
  await prisma.syncCursor.upsert({
    where: { companyId_entity: { companyId, entity } },
    update: data,
    create: { companyId, entity, ...data },
  });
}
