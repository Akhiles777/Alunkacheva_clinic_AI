import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import type { AuditAction } from "@/generated/prisma/enums";

/**
 * Аудит-лог (§7, §9). Пишем факт действия: кто, когда, что, над чем, откуда.
 * Тела сообщений, телефоны и содержимое секретов сюда не попадают — только
 * идентификаторы и тип действия.
 *
 * Адрес и устройство берём из запроса. Колонки для них были с самого начала,
 * но не заполнялись: на вопрос «кто и с какого устройства менял ставки в семь
 * утра» журнал ответить не мог — а он для этого и нужен.
 */
async function requestOrigin(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    const h = await headers();
    // За обратным прокси реальный адрес приходит в x-forwarded-for первым
    // элементом списка; на Vercel есть и собственный заголовок.
    const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    return {
      ip: h.get("x-real-ip") || forwarded || null,
      userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
    };
  } catch {
    // Вне контекста запроса (фоновые задачи) заголовков нет — это не ошибка.
    return { ip: null, userAgent: null };
  }
}

export async function writeAudit(input: {
  companyId: string;
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const origin = await requestOrigin();
  await prisma.auditLog.create({
    data: {
      companyId: input.companyId,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      ip: origin.ip,
      userAgent: origin.userAgent,
      meta: input.meta as object | undefined,
    },
  });
}
