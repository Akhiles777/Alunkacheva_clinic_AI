"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import { codeFromTitle, templateVariables } from "@/lib/message-template";
import {
  STATUS_BACK,
  STATUS_TO_DB,
  listTemplates,
  type TemplateRow,
} from "@/lib/server/message-templates";
import type { TemplateItem } from "@/app/_data/settings";

/**
 * Шаблоны WhatsApp — в доменной таблице MessageTemplate.
 *
 * Раньше они лежали JSON-настройкой и были декорацией: добавить или удалить
 * шаблон было нельзя, статус не менялся, а таблица под них существовала и
 * пустовала. Администратор правил текст двух зашитых строк и не понимал,
 * почему нельзя завести третью.
 *
 * Переносим при первом чтении: у клиники в настройке уже лежат её тексты, и
 * терять их нельзя.
 */

export async function getTemplates(): Promise<TemplateRow[]> {
  const session = await getSession();
  return listTemplates(session.companyId);
}

export interface TemplateDraft {
  id?: string;
  title: string;
  body: string;
  status: TemplateItem["status"];
}

export async function saveTemplate(
  draft: TemplateDraft,
): Promise<{ ok: true; row: TemplateRow } | { ok: false; error: string }> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  const title = draft.title.trim();
  const body = draft.body.trim();
  if (!title) return { ok: false, error: "У шаблона должно быть название" };
  if (!body) return { ok: false, error: "У шаблона не может быть пустого текста" };

  const taken = (
    await prisma.messageTemplate.findMany({
      where: { companyId: session.companyId, ...(draft.id ? { NOT: { id: draft.id } } : {}) },
      select: { code: true },
    })
  ).map((r) => r.code);

  const saved = draft.id
    ? await prisma.messageTemplate.update({
        where: { id: draft.id },
        data: { title, bodyTemplate: body, status: STATUS_TO_DB[draft.status] },
      })
    : await prisma.messageTemplate.create({
        data: {
          companyId: session.companyId,
          channel: "WHATSAPP",
          code: codeFromTitle(title, taken),
          title,
          bodyTemplate: body,
          status: STATUS_TO_DB[draft.status],
        },
      });

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "message_template",
    entityId: saved.id,
  });

  return {
    ok: true,
    row: {
      id: saved.id,
      code: saved.code,
      title: saved.title,
      body: saved.bodyTemplate,
      status: STATUS_BACK[saved.status] ?? "draft",
      variables: templateVariables(saved.bodyTemplate),
    },
  };
}

export async function deleteTemplate(id: string): Promise<{ ok: true }> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  await prisma.messageTemplate.deleteMany({ where: { id, companyId: session.companyId } });
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "message_template",
    entityId: id,
  });
  return { ok: true };
}
