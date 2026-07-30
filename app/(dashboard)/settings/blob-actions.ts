"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";

/**
 * Универсальное хранение секции настроек как JSON в таблице Setting — ровно то,
 * для чего она задумана (§4: «всё, что было в env/сиде/константах»). Чтение без
 * прав, запись — только с EDIT_SETTINGS и с аудитом.
 *
 * Секции: sources, services, rooms, assistant, templates, notifications.
 * Доменная нормализация (Service/Source/Room строками) — отдельная задача.
 */
export async function getSection(key: string): Promise<unknown | null> {
  const session = await getSession();
  const row = await prisma.setting.findUnique({
    where: { companyId_key: { companyId: session.companyId, key } },
  });
  return row ? row.value : null;
}

export async function saveSection(key: string, value: unknown): Promise<{ ok: true }> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  await prisma.setting.upsert({
    where: { companyId_key: { companyId: session.companyId, key } },
    update: { value: value as object, updatedById: session.userId },
    create: { companyId: session.companyId, key, value: value as object },
  });

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: key,
  });

  return { ok: true };
}
