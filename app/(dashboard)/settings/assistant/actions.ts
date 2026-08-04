"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import type { KnowledgeItem } from "@/app/_data/settings";

/**
 * База знаний ассистента — в доменной таблице KnowledgeEntry, из которой её и
 * читает агент.
 *
 * Раньше раздел сохранял записи в JSON-настройку Setting["assistant"], а бот
 * читал KnowledgeEntry. Администратор заполнял базу знаний и был уверен, что
 * настроил ассистента, — а тот про эти тексты не знал и на каждый вопрос звал
 * человека. Теперь источник один.
 *
 * Конфигурация (режим, приветствие, подпись, стоп-слова) остаётся в Setting:
 * это настройки поведения, а не знания.
 */
export interface AssistantConfig {
  mode: "on" | "off" | "drafts";
  greeting: string;
  signature: string;
  stopWords: string[];
}

export async function getKnowledge(): Promise<KnowledgeItem[]> {
  const session = await getSession();
  const rows = await prisma.knowledgeEntry.findMany({
    where: { companyId: session.companyId },
    orderBy: { topic: "asc" },
    select: { id: true, topic: true, question: true, answer: true, serviceId: true, isActive: true },
  });
  return rows;
}

export async function saveKnowledge(items: KnowledgeItem[]): Promise<KnowledgeItem[]> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  for (const k of items) {
    if (!k.topic.trim()) throw new Error("У записи должна быть тема");
    if (k.isActive && !k.answer.trim()) {
      throw new Error(`Заполните ответ для темы «${k.topic}» или выключите запись`);
    }
  }

  const existing = await prisma.knowledgeEntry.findMany({
    where: { companyId: session.companyId },
    select: { id: true },
  });
  const kept = new Set(items.filter((k) => !k.id.startsWith("new-")).map((k) => k.id));

  await prisma.$transaction(async (tx) => {
    // Удалённые в интерфейсе строки убираем и из базы: знание, которого нет в
    // списке, не должно продолжать звучать в ответах пациенту.
    const toDelete = existing.filter((e) => !kept.has(e.id)).map((e) => e.id);
    if (toDelete.length) {
      await tx.knowledgeEntry.deleteMany({ where: { id: { in: toDelete } } });
    }

    for (const k of items) {
      const data = {
        topic: k.topic.trim(),
        question: k.question.trim(),
        answer: k.answer.trim(),
        serviceId: k.serviceId || null,
        isActive: k.isActive,
        updatedById: session.userId,
      };
      if (k.id.startsWith("new-")) {
        await tx.knowledgeEntry.create({ data: { companyId: session.companyId, ...data } });
      } else {
        await tx.knowledgeEntry.update({ where: { id: k.id }, data });
      }
    }
  });

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "knowledge",
    meta: { count: items.length },
  });

  return getKnowledge();
}
