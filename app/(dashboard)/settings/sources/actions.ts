"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import type { SourceKind } from "@/generated/prisma/enums";

/**
 * Источники обращений — доменная таблица Source. Сохранение целиком (reconcile):
 * добавление, переименование, переупорядочивание и удаление за одну транзакцию.
 * Источник, к которому привязана история (пациенты, визиты, звонки, обращения),
 * удалить нельзя — только деактивировать, иначе потеряется атрибуция воронки.
 */
export interface SourceRow {
  id: string; // существующие — cuid; новые — "new-*"
  code: string;
  title: string;
  kind: SourceKind;
  isActive: boolean;
}

function slug(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-я]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return base || "source";
}

export async function getSources(): Promise<SourceRow[]> {
  const session = await getSession();
  const rows = await prisma.source.findMany({
    where: { companyId: session.companyId },
    orderBy: { sortOrder: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    title: r.title,
    kind: r.kind,
    isActive: r.isActive,
  }));
}

export async function saveSources(rows: SourceRow[]): Promise<SourceRow[]> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  if (rows.some((r) => r.title.trim().length === 0)) {
    throw new Error("У источника не может быть пустого названия");
  }

  const existing = await prisma.source.findMany({
    where: { companyId: session.companyId },
    select: { id: true, code: true, title: true },
  });
  const keptIds = new Set(rows.filter((r) => !r.id.startsWith("new-")).map((r) => r.id));
  const toDelete = existing.filter((e) => !keptIds.has(e.id));

  // Защита: нельзя удалить источник с историей.
  for (const del of toDelete) {
    const [patients, appts, calls] = await Promise.all([
      prisma.patient.count({ where: { sourceId: del.id } }),
      prisma.appointment.count({ where: { sourceId: del.id } }),
      prisma.callLog.count({ where: { sourceId: del.id } }),
    ]);
    if (patients + appts + calls > 0) {
      throw new Error(
        `Источник «${del.title}» удалить нельзя: с ним связана история (пациентов ${patients}, визитов ${appts}, звонков ${calls}). Деактивируйте его.`,
      );
    }
  }

  // Уникальность кодов внутри итогового набора.
  const usedCodes = new Set<string>();
  const resolved = rows.map((r) => {
    let code = (r.code.trim() || slug(r.title)).toLowerCase();
    if (usedCodes.has(code)) {
      let i = 2;
      while (usedCodes.has(`${code}_${i}`)) i++;
      code = `${code}_${i}`;
    }
    usedCodes.add(code);
    return { ...r, code };
  });

  await prisma.$transaction(async (tx) => {
    for (const del of toDelete) {
      await tx.source.delete({ where: { id: del.id } });
    }
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      const data = {
        code: r.code,
        title: r.title.trim(),
        kind: r.kind,
        isActive: r.isActive,
        sortOrder: (i + 1) * 10,
      };
      if (r.id.startsWith("new-")) {
        await tx.source.create({ data: { companyId: session.companyId, ...data } });
      } else {
        await tx.source.update({ where: { id: r.id }, data });
      }
    }
  });

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "sources",
    meta: { count: resolved.length, deleted: toDelete.length },
  });

  return getSources();
}
