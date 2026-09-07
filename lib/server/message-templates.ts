import { prisma } from "@/lib/db";
import { codeFromTitle, templateVariables } from "@/lib/message-template";
import { settingsStore, type TemplateItem } from "@/app/_data/settings";

/**
 * Шаблоны WhatsApp — чтение и перенос из старой JSON-настройки.
 *
 * Живёт в серверном слое, а не в server action, по той же причине, по которой
 * там живут метрики: одну и ту же вещь считает и экран, и разовый скрипт.
 * Перенос, спрятанный в действии страницы, нельзя ни проверить, ни повторить —
 * а он трогает тексты, которые писала клиника.
 */

const STATUS: Record<TemplateItem["status"], "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED"> =
  {
    draft: "DRAFT",
    pending: "PENDING_APPROVAL",
    approved: "APPROVED",
    rejected: "REJECTED",
  };

export const STATUS_BACK: Record<string, TemplateItem["status"]> = {
  DRAFT: "draft",
  PENDING_APPROVAL: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
};

export { STATUS as STATUS_TO_DB };

export interface TemplateRow extends TemplateItem {
  variables: string[];
}

/**
 * Перенос из JSON-настройки в таблицу — один раз, при первом чтении.
 *
 * Раздел «Шаблоны» сохранял тексты в Setting, а таблица под них пустовала.
 * Молча потерять эти тексты нельзя: клиника их писала. Если в таблице уже
 * что-то есть, перенос не трогает ничего.
 */
export async function ensureTemplates(companyId: string): Promise<number> {
  const count = await prisma.messageTemplate.count({ where: { companyId } });
  if (count > 0) return 0;

  const row = await prisma.setting.findUnique({
    where: { companyId_key: { companyId, key: "templates" } },
    select: { value: true },
  });
  const stored = (row?.value as { templates?: TemplateItem[] } | null)?.templates;
  const source = stored?.length ? stored : settingsStore.templates;

  let moved = 0;
  const taken: string[] = [];
  for (const t of source) {
    const body = t.body?.trim();
    if (!body) continue;
    const code = t.code?.trim() || codeFromTitle(t.title ?? "Шаблон", taken);
    taken.push(code);
    const created = await prisma.messageTemplate
      .create({
        data: {
          companyId,
          channel: "WHATSAPP",
          code,
          title: t.title?.trim() || "Без названия",
          bodyTemplate: body,
          status: STATUS[t.status] ?? "DRAFT",
        },
        select: { id: true },
      })
      .catch(() => null);
    if (created) moved += 1;
  }
  return moved;
}

export async function listTemplates(companyId: string): Promise<TemplateRow[]> {
  await ensureTemplates(companyId);
  const rows = await prisma.messageTemplate.findMany({
    where: { companyId, channel: "WHATSAPP" },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    title: r.title,
    body: r.bodyTemplate,
    status: STATUS_BACK[r.status] ?? "draft",
    variables: templateVariables(r.bodyTemplate),
  }));
}
