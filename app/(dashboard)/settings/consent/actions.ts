"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";

/**
 * Согласие на обработку ПДн (§4.10). Версии текста хранятся в ConsentDocument;
 * активна одна. Смена версии = деактивация прежней и активация новой — так
 * фиксируется, что согласие нужно запросить заново при следующем контакте.
 */
export interface ConsentData {
  version: string;
  text: string;
  policyUrl: string;
}

export async function getConsent(): Promise<ConsentData> {
  const session = await getSession();
  const doc = await prisma.consentDocument.findFirst({
    where: { companyId: session.companyId, isActive: true },
    orderBy: { createdAt: "desc" },
  });
  return {
    version: doc?.version ?? "1.0",
    text: doc?.text ?? "",
    policyUrl: doc?.policyUrl ?? "",
  };
}

export async function saveConsent(data: ConsentData): Promise<{ ok: true; versionChanged: boolean }> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  const current = await prisma.consentDocument.findFirst({
    where: { companyId: session.companyId, isActive: true },
    orderBy: { createdAt: "desc" },
  });

  const version = data.version.trim();
  const versionChanged = !current || current.version !== version;

  if (!versionChanged) {
    // Та же версия — правим текст/ссылку.
    await prisma.consentDocument.update({
      where: { id: current!.id },
      data: { text: data.text, policyUrl: data.policyUrl || null },
    });
  } else {
    // Новая версия: гасим прежнюю активную, создаём/активируем новую.
    await prisma.$transaction([
      prisma.consentDocument.updateMany({
        where: { companyId: session.companyId, isActive: true },
        data: { isActive: false },
      }),
      prisma.consentDocument.upsert({
        where: { companyId_version: { companyId: session.companyId, version } },
        update: { text: data.text, policyUrl: data.policyUrl || null, isActive: true },
        create: {
          companyId: session.companyId,
          version,
          text: data.text,
          policyUrl: data.policyUrl || null,
          isActive: true,
          createdById: session.userId,
        },
      }),
    ]);
  }

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "consent",
    entityId: version,
    meta: { versionChanged },
  });

  return { ok: true, versionChanged };
}
