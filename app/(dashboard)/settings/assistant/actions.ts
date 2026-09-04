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
  /**
   * Инструкция ассистента: порядок разговора и что спрашивать при записи.
   * Дописывается к базовым правилам, не заменяет их — см. lib/agent/intake.
   */
  prompt: string;
}

export async function getKnowledge(): Promise<KnowledgeItem[]> {
  const session = await getSession();
  const rows = await prisma.knowledgeEntry.findMany({
    where: { companyId: session.companyId },
    // Устойчивый порядок: у записей с одинаковой темой он иначе прыгает при
    // каждом сохранении, и строка «уезжает» из-под курсора.
    orderBy: [{ topic: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      topic: true,
      question: true,
      answer: true,
      serviceId: true,
      isActive: true,
      needsDoctorApproval: true,
      approvedAt: true,
      approvedBy: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    topic: r.topic,
    question: r.question,
    answer: r.answer,
    serviceId: r.serviceId,
    isActive: r.isActive,
    needsDoctorApproval: r.needsDoctorApproval,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    approvedByName: r.approvedBy?.name ?? null,
  }));
}

/** Ключ, по которому запись узнаётся независимо от идентификатора. */
function naturalKey(topic: string, question: string): string {
  return `${topic.trim().toLowerCase()}\u0000${question.trim().toLowerCase()}`;
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

  /**
   * Внутри одной отправки записи с одинаковой темой и вопросом схлопываем:
   * двойное нажатие или задвоившаяся строка на экране не должны превращаться
   * в две строки в базе. Побеждает последняя — это то, что человек видит.
   */
  const deduped = new Map<string, KnowledgeItem>();
  for (const k of items) deduped.set(naturalKey(k.topic, k.question), k);

  /**
   * Что считать новой записью.
   *
   * Раньше решал идентификатор, присланный экраном: не нашли в базе — создаём.
   * Экран выдаёт новым строкам собственный идентификатор, и любое расхождение
   * (устаревшее состояние, повторная отправка, вторая вкладка) порождало
   * копию. На боевом стенде так набралось 417 записей при 66 уникальных.
   *
   * Теперь запись узнаётся по теме и вопросу — по тому, что видит человек.
   * Идентификатор остаётся подсказкой: если он совпал, обновляем именно её,
   * даже когда тему переименовали.
   */
  const existing = await prisma.knowledgeEntry.findMany({
    where: { companyId: session.companyId },
    select: {
      id: true,
      topic: true,
      question: true,
      answer: true,
      needsDoctorApproval: true,
      approvedAt: true,
    },
  });
  const byId = new Map(existing.map((e) => [e.id, e]));
  const byKey = new Map(existing.map((e) => [naturalKey(e.topic, e.question), e.id]));

  const updates: { id: string; data: Record<string, unknown> }[] = [];
  const creates: Record<string, unknown>[] = [];

  for (const k of deduped.values()) {
    const data: Record<string, unknown> = {
      topic: k.topic.trim(),
      question: k.question.trim(),
      answer: k.answer.trim(),
      serviceId: k.serviceId || null,
      isActive: k.isActive,
      updatedById: session.userId,
    };
    const targetId = byId.has(k.id) ? k.id : byKey.get(naturalKey(k.topic, k.question));
    const before = targetId ? byId.get(targetId) : undefined;

    /**
     * Медицинская отметка приходит не от экрана, а из базы.
     *
     * Иначе снять её мог бы кто угодно, отправив форму без этого поля, — и
     * весь смысл утверждения врачом сводился бы к галочке, которую можно
     * обойти. У новой записи отметку задаёт то, откуда она создаётся: экран
     * «Пробелы» помечает медицинские группы сам.
     */
    const medical = before ? before.needsDoctorApproval : Boolean(k.needsDoctorApproval);
    data.needsDoctorApproval = medical;

    /**
     * Утверждение врача относится к КОНКРЕТНОМУ тексту. Текст переписали —
     * утверждения больше нет: иначе достаточно получить одобрение на
     * безобидную справку и заменить её содержимое.
     */
    if (before?.approvedAt && medical) {
      const changed =
        before.answer.trim() !== data.answer ||
        before.question.trim() !== data.question ||
        before.topic.trim() !== data.topic;
      if (changed) {
        data.approvedAt = null;
        data.approvedById = null;
        data.isActive = false;
      }
    }

    /**
     * Неутверждённая медицинская справка не включается. Не «включается с
     * предупреждением» — предупреждение увидит администратор, а текст прочтёт
     * пациент.
     */
    if (medical && !before?.approvedAt && data.isActive) {
      throw new Error(
        `Тема «${k.topic}» медицинская: включить запись можно после утверждения врачом`,
      );
    }

    if (targetId) updates.push({ id: targetId, data });
    else creates.push({ companyId: session.companyId, ...data });
  }

  /**
   * Одна вставка на все новые строки вместо запроса на каждую. Прежний цикл
   * с отдельным обращением к базе на запись работал около секунды на строку —
   * на четырёх сотнях записей экран замирал на минуты, а транзакция рисковала
   * упереться в таймаут.
   */
  await prisma.$transaction(
    async (tx) => {
      if (creates.length > 0) {
        await tx.knowledgeEntry.createMany({ data: creates as never, skipDuplicates: true });
      }
      for (const u of updates) {
        await tx.knowledgeEntry.updateMany({
          where: { id: u.id, companyId: session.companyId },
          data: u.data,
        });
      }
    },
    // Правок может быть много: значение по умолчанию (5 с) обрывало сохранение
    // на середине, и человек видел, что часть записей не сохранилась.
    { timeout: 120_000, maxWait: 10_000 },
  );

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "knowledge",
    meta: { updated: updates.length, created: creates.length },
  });

  return getKnowledge();
}

export async function deleteKnowledge(id: string): Promise<KnowledgeItem[]> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  const result = await prisma.knowledgeEntry.deleteMany({
    where: { id, companyId: session.companyId },
  });

  if (result.count === 0) throw new Error("Запись базы знаний не найдена");

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "knowledge",
    entityId: id,
    meta: { deleted: 1 },
  });

  return getKnowledge();
}

/**
 * Кто вправе утверждать медицинскую справку.
 *
 * Врач и владелец. Администратор — нет: он пишет пациентам каждый день и
 * лучше всех знает, как ответить вежливо, но за противопоказание отвечает не
 * он. Право «править настройки» здесь не подходит по смыслу — оно про
 * настройки, а не про медицину.
 */
const APPROVERS = ["DOCTOR", "OWNER"] as const;

function assertApprover(role: string) {
  if (!(APPROVERS as readonly string[]).includes(role)) {
    throw new Error("Утвердить медицинскую справку может врач или владелец");
  }
}

/**
 * Утвердить медицинскую справку.
 *
 * Утверждение относится к тому тексту, который врач прочитал: правка текста
 * снимает его (см. saveKnowledge). Поэтому здесь ничего, кроме отметки, не
 * меняется — включает запись человек отдельным действием и осознанно.
 */
export async function approveKnowledge(id: string): Promise<KnowledgeItem[]> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  assertApprover(session.role);

  const result = await prisma.knowledgeEntry.updateMany({
    where: { id, companyId: session.companyId, needsDoctorApproval: true },
    data: { approvedAt: new Date(), approvedById: session.userId },
  });
  if (result.count === 0) throw new Error("Запись не найдена или не требует утверждения");

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "knowledge",
    entityId: id,
    meta: { approved: true },
  });
  return getKnowledge();
}

/**
 * Отозвать утверждение — и сразу выключить запись.
 *
 * Врач передумал; оставить текст работающим «до выяснения» нельзя: пациенты
 * получают ответы каждую минуту, а выяснение занимает дни.
 */
export async function revokeKnowledgeApproval(id: string): Promise<KnowledgeItem[]> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  assertApprover(session.role);

  const result = await prisma.knowledgeEntry.updateMany({
    where: { id, companyId: session.companyId, needsDoctorApproval: true },
    data: { approvedAt: null, approvedById: null, isActive: false },
  });
  if (result.count === 0) throw new Error("Запись не найдена или не требует утверждения");

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "knowledge",
    entityId: id,
    meta: { approvalRevoked: true },
  });
  return getKnowledge();
}
