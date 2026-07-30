import { prisma } from "@/lib/db";
import type { AuditAction } from "@/generated/prisma/enums";

/**
 * Аудит-лог (§9). Пишем факт действия: кто, когда, что, над чем. Тела
 * сообщений, телефоны и содержимое секретов сюда не попадают — только
 * идентификаторы и тип действия.
 */
export async function writeAudit(input: {
  companyId: string;
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      companyId: input.companyId,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      meta: input.meta as object | undefined,
    },
  });
}
