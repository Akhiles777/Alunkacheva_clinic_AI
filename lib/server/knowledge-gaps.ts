import { prisma } from "@/lib/db";
import { groupGaps, type GapAnswer, type GapCluster, type GapQuestion } from "@/lib/agent/gaps";

/**
 * Пробелы в справочнике — из базы.
 *
 * Чтение и склейка; вся логика группировки живёт в чистых функциях
 * `lib/agent/gaps.ts` и покрыта тестами. Здесь только три вопроса к базе:
 * какие эскалации означают «ответить было нечем», что спросил пациент перед
 * такой эскалацией и чем ответил сотрудник после.
 *
 * Ничего не пишет. Запись справочника из этого экрана создаёт человек — и
 * только руками (см. комментарий к `lib/agent/gaps.ts`).
 */

/** Эскалации, означающие отсутствие ответа, а не запрет темы. */
const GAP_REASONS = ["MISUNDERSTOOD", "MEDICAL_QUESTION"] as const;

/** За сколько дней смотрим. Пробел — это то, что спрашивают сейчас. */
export const GAP_WINDOW_DAYS = 90;

export interface KnowledgeUsage {
  entryId: string;
  /** Сколько раз запись составила ответ пациенту за окно. */
  used: number;
  lastUsedAt: Date | null;
}

export interface GapsReport {
  clusters: GapCluster[];
  /** Сколько эскалаций рассмотрено — знаменатель для «покрыли N из M». */
  total: number;
  /** Эскалации без вопроса пациента: переписки не нашлось. */
  withoutQuestion: number;
  from: Date;
  to: Date;
  usage: KnowledgeUsage[];
  /**
   * С какого момента журнал попыток вообще ведётся.
   *
   * Без этой даты ноль напротив записи читается как «бесполезна», хотя может
   * означать «журнала тогда ещё не было». Разница существенная: по первому
   * прочтению запись удаляют.
   */
  usageSince: Date | null;
}

export async function getKnowledgeGaps(companyId: string): Promise<GapsReport> {
  const to = new Date();
  const from = new Date(to.getTime() - GAP_WINDOW_DAYS * 24 * 3600 * 1000);

  const escalations = await prisma.escalation.findMany({
    where: {
      companyId,
      reason: { in: [...GAP_REASONS] },
      createdAt: { gte: from, lte: to },
    },
    select: { id: true, conversationId: true, reason: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const usageSince = await firstRunAt(companyId);

  if (escalations.length === 0) {
    return {
      clusters: [],
      total: 0,
      withoutQuestion: 0,
      from,
      to,
      usage: await usageOf(companyId, from),
      usageSince,
    };
  }

  /**
   * Сообщения тех же диалогов за окно. Читаем одним запросом и раскладываем в
   * памяти: эскалаций за квартал десятки, а ходить в базу за каждой — сотни
   * запросов на открытие экрана настроек.
   */
  const conversationIds = [...new Set(escalations.map((e) => e.conversationId))];
  const messages = await prisma.message.findMany({
    where: {
      conversationId: { in: conversationIds },
      deletedAt: null,
      isDraft: false,
      createdAt: { gte: new Date(from.getTime() - 24 * 3600 * 1000), lte: to },
      authorType: { in: ["PATIENT", "STAFF"] },
    },
    select: {
      conversationId: true,
      authorType: true,
      body: true,
      createdAt: true,
      authorId: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const byConversation = new Map<string, typeof messages>();
  for (const m of messages) {
    const list = byConversation.get(m.conversationId);
    if (list) list.push(m);
    else byConversation.set(m.conversationId, [m]);
  }

  /**
   * Имена сотрудников: кто именно ответил. Экран показывает автора ответа —
   * администратор должен видеть, чей текст он собирается превратить в справку.
   */
  const staffIds = [...new Set(messages.map((m) => m.authorId).filter((id): id is string => Boolean(id)))];
  const staff = staffIds.length
    ? await prisma.staffUser.findMany({
        where: { id: { in: staffIds }, companyId },
        select: { id: true, name: true },
      })
    : [];
  const staffNames = new Map(staff.map((s) => [s.id, s.name]));

  /** Ответ сотрудника считаем ответом на этот вопрос, если он пришёл в сутки. */
  const ANSWER_WINDOW_MS = 24 * 3600 * 1000;

  const questions: GapQuestion[] = [];
  let withoutQuestion = 0;

  for (const e of escalations) {
    const thread = byConversation.get(e.conversationId) ?? [];

    /**
     * Вопрос — последнее сообщение пациента ПЕРЕД эскалацией.
     *
     * Именно на него агент не смог ответить. Брать первое сообщение диалога
     * нельзя: постоянный пациент пишет в тот же чат месяцами, и первым там
     * стоит «здравствуйте» позапрошлого года.
     */
    const asked = [...thread]
      .reverse()
      .find(
        (m) =>
          m.authorType === "PATIENT" &&
          m.createdAt <= e.createdAt &&
          // Пустое тело — это фотография или голосовое. Останавливаться на
          // нём нельзя: вопрос словами был строкой раньше, и без него
          // эскалация уходила в «вопрос не нашёлся».
          m.body.trim().length > 0,
      );
    if (!asked) {
      withoutQuestion += 1;
      continue;
    }

    /**
     * Ответ — первое сообщение сотрудника после эскалации.
     *
     * Это черновик будущей справки, а не сама справка: администратор писал
     * конкретному пациенту, зная его случай. Поэтому текст показывается как
     * есть и правится человеком, а не переносится в справочник как готовый.
     */
    const replied = thread.find(
      (m) =>
        m.authorType === "STAFF" &&
        m.createdAt > e.createdAt &&
        m.createdAt.getTime() - e.createdAt.getTime() <= ANSWER_WINDOW_MS &&
        m.body.trim().length > 0,
    );
    const answer: GapAnswer | null = replied
      ? {
          text: replied.body.trim(),
          at: replied.createdAt,
          authorName: replied.authorId ? (staffNames.get(replied.authorId) ?? null) : null,
        }
      : null;

    questions.push({
      id: e.id,
      conversationId: e.conversationId,
      text: asked.body.trim(),
      at: e.createdAt,
      reason: e.reason,
      answer,
    });
  }

  return {
    clusters: groupGaps(questions),
    total: escalations.length,
    withoutQuestion,
    from,
    to,
    usage: await usageOf(companyId, from),
    usageSince,
  };
}

/** Первая запись журнала попыток: раньше неё счёт ответов не вёлся. */
async function firstRunAt(companyId: string): Promise<Date | null> {
  const row = await prisma.agentRun.findFirst({
    where: { companyId },
    orderBy: { triggeredAt: "asc" },
    select: { triggeredAt: true },
  });
  return row?.triggeredAt ?? null;
}

/**
 * Сколько раз каждая запись справочника действительно составила ответ.
 *
 * Считается по журналу попыток (`AgentRun.knowledgeEntryIds`), а не отдельным
 * счётчиком в самой записи: счётчик разъедется с фактами при первом же сбое
 * пересчёта, и объяснить расхождение будет нечем. Запись с нулём — тоже
 * ответ: либо о ней не спрашивают, либо подбор её не находит.
 */
async function usageOf(companyId: string, from: Date): Promise<KnowledgeUsage[]> {
  const runs = await prisma.agentRun.findMany({
    where: {
      companyId,
      triggeredAt: { gte: from },
      outcome: "OK",
      NOT: { knowledgeEntryIds: { isEmpty: true } },
    },
    select: { knowledgeEntryIds: true, triggeredAt: true },
  });

  const acc = new Map<string, { used: number; lastUsedAt: Date }>();
  for (const r of runs) {
    for (const id of r.knowledgeEntryIds) {
      const cur = acc.get(id);
      if (cur) {
        cur.used += 1;
        if (r.triggeredAt > cur.lastUsedAt) cur.lastUsedAt = r.triggeredAt;
      } else {
        acc.set(id, { used: 1, lastUsedAt: r.triggeredAt });
      }
    }
  }
  return [...acc].map(([entryId, v]) => ({ entryId, used: v.used, lastUsedAt: v.lastUsedAt }));
}
