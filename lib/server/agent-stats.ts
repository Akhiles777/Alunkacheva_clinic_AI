import { prisma } from "@/lib/db";
import { periodBounds } from "@/lib/server/analytics";
import type { PeriodKey } from "@/lib/metrics/types";
import {
  agentAutonomy,
  agentReliability,
  closedByAgent,
  escalationBreakdown,
  type AgentAutonomy,
  type AgentReliability,
  type AutonomyDialog,
  type EscalationSlice,
} from "@/lib/metrics/agent";
import {
  escalationResponseTime,
  firstResponseTime,
  type DialogMessage,
  type FirstResponseReport,
  type FirstResponseStats,
  type WorkingHours,
} from "@/lib/metrics/response-time";
import { agentSavings, type SavingsReport } from "@/lib/metrics/agent-savings";
import { confidentMatch, matchKnowledge, type KnowledgeRow } from "@/lib/agent/knowledge";

/**
 * Данные для раздела «Работа ассистента».
 *
 * Здесь только чтение базы и склейка: каждое число считает функция из
 * `lib/metrics/`. Экран не считает ничего — иначе у клиники появится ещё одна
 * правда о работе агента, как это уже было с выручкой.
 */

export interface AgentStats {
  /** Были ли в периоде хоть какие-то данные. Пусто — так и пишем на экране. */
  hasData: boolean;
  reliability: AgentReliability;
  autonomy: AgentAutonomy;
  escalations: EscalationSlice[];
  escalationAck: FirstResponseStats & { unacknowledged: number };
  responseTime: FirstResponseReport;
  savings: SavingsReport;
}

/**
 * Тема вопроса по справочнику клиники.
 *
 * Одним и тем же подборщиком и для агента, и для ручных ответов: сравнивать
 * можно только то, что размечено одинаково. Не опознали тему — вопрос в расчёт
 * экономии не идёт вовсе.
 */
function topicOf(question: string, rows: KnowledgeRow[]): string | null {
  const m = matchKnowledge(question, rows);
  return m && confidentMatch(m) ? m.row.topic : null;
}

export async function getAgentStats(companyId: string, period: PeriodKey): Promise<AgentStats> {
  const { from, to } = periodBounds(period);

  const [runs, escalations, messages, schedule, knowledge] = await Promise.all([
    prisma.agentRun.findMany({
      where: { companyId, triggeredAt: { gte: from, lt: to } },
      select: {
        id: true,
        conversationId: true,
        outcome: true,
        triggeredAt: true,
        latencyMs: true,
        retryOf: true,
        knowledgeEntryIds: true,
      },
      orderBy: { triggeredAt: "asc" },
    }),
    prisma.escalation.findMany({
      where: { companyId, createdAt: { gte: from, lt: to } },
      select: {
        conversationId: true,
        reason: true,
        createdAt: true,
        notifiedAt: true,
        acknowledgedAt: true,
      },
    }),
    /**
     * Сообщения периода. Черновики и удалённые не в счёт: первого их пациент
     * не видел, второго больше нет.
     */
    prisma.message.findMany({
      where: {
        companyId,
        deletedAt: null,
        isDraft: false,
        createdAt: { gte: from, lt: to },
      },
      select: {
        conversationId: true,
        direction: true,
        authorType: true,
        authorId: true,
        channel: true,
        body: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.clinicSchedule.findMany({
      where: { companyId },
      select: { weekday: true, startMinute: true, endMinute: true },
    }),
    prisma.knowledgeEntry.findMany({
      where: { companyId, isActive: true },
      select: { id: true, topic: true, question: true, answer: true },
    }),
  ]);

  // ── надёжность и эскалации: чистые функции над строками
  const reliability = agentReliability(runs);
  const escalationSlices = escalationBreakdown(escalations);
  const escalationAck = escalationResponseTime(escalations);

  // ── скорость ответа
  const dialogMessages: DialogMessage[] = messages.map((m) => ({
    conversationId: m.conversationId,
    direction: m.direction,
    authorType: m.authorType,
    channel: m.channel,
    createdAt: m.createdAt,
    staffUserId: m.authorType === "STAFF" ? m.authorId : null,
  }));
  const responseTime = firstResponseTime(dialogMessages, schedule as WorkingHours[]);

  /**
   * Автономность: по каждому диалогу, где агент отвечал в периоде, смотрим,
   * что случилось ПОСЛЕ его последнего ответа. Вмешательство ищем и за
   * пределами периода — сутки после ответа могут выходить за его границу, и
   * обрезать их значило бы записать в успех то, что человек разгребал завтра.
   */
  const lastAgentReply = new Map<string, Date>();
  for (const m of messages) {
    if (m.direction === "OUT" && m.authorType === "BOT") lastAgentReply.set(m.conversationId, m.createdAt);
  }

  const dialogs: AutonomyDialog[] = [];
  if (lastAgentReply.size > 0) {
    const ids = [...lastAgentReply.keys()];
    const horizon = new Date(to.getTime() + 24 * 60 * 60 * 1000);
    const [after, escAfter] = await Promise.all([
      prisma.message.findMany({
        where: {
          conversationId: { in: ids },
          deletedAt: null,
          isDraft: false,
          createdAt: { gte: from, lt: horizon },
          authorType: { in: ["STAFF", "PATIENT"] },
        },
        select: { conversationId: true, authorType: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.escalation.findMany({
        where: { conversationId: { in: ids }, createdAt: { gte: from, lt: horizon } },
        select: { conversationId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const firstAfter = (rows: { conversationId: string; createdAt: Date }[], id: string, at: Date) =>
      rows.find((r) => r.conversationId === id && r.createdAt.getTime() > at.getTime())?.createdAt ?? null;

    for (const [conversationId, agentRepliedAt] of lastAgentReply) {
      dialogs.push({
        conversationId,
        agentRepliedAt,
        staffRepliedAt: firstAfter(
          after.filter((m) => m.authorType === "STAFF"),
          conversationId,
          agentRepliedAt,
        ),
        patientRepliedAt: firstAfter(
          after.filter((m) => m.authorType === "PATIENT"),
          conversationId,
          agentRepliedAt,
        ),
        escalatedAt: firstAfter(escAfter, conversationId, agentRepliedAt),
      });
    }
  }
  const autonomy = agentAutonomy(dialogs);

  // ── экономия времени
  const topicByEntry = new Map(knowledge.map((k) => [k.id, k.topic]));
  const topicByDialog = new Map<string, string>();
  for (const r of runs) {
    for (const id of r.knowledgeEntryIds) {
      const topic = topicByEntry.get(id);
      if (topic) topicByDialog.set(r.conversationId, topic);
    }
  }

  const closedTopics = new Map<string, number>();
  for (const d of dialogs) {
    if (!closedByAgent(d)) continue;
    const topic = topicByDialog.get(d.conversationId);
    // Тему не знаем — в расчёт не берём: сравнивать не с чем.
    if (!topic) continue;
    closedTopics.set(topic, (closedTopics.get(topic) ?? 0) + 1);
  }

  /**
   * Ручные ответы за 90 дней — база сравнения.
   *
   * Берём шире периода намеренно: за неделю ручных ответов по теме почти
   * наверняка меньше пяти, и вся экономия схлопнулась бы в «недостаточно
   * данных» на ровном месте.
   */
  const manualSince = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
  const manualRows = await prisma.message.findMany({
    where: {
      companyId,
      deletedAt: null,
      isDraft: false,
      createdAt: { gte: manualSince, lt: to },
      authorType: { in: ["PATIENT", "STAFF"] },
    },
    select: { conversationId: true, authorType: true, body: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const manual: { topic: string; ms: number }[] = [];
  const pending = new Map<string, { at: Date; body: string }>();
  for (const m of manualRows) {
    if (m.authorType === "PATIENT") {
      if (!pending.has(m.conversationId)) pending.set(m.conversationId, { at: m.createdAt, body: m.body });
      continue;
    }
    const ask = pending.get(m.conversationId);
    if (!ask) continue;
    pending.delete(m.conversationId);
    const topic = topicOf(ask.body, knowledge);
    if (!topic) continue;
    manual.push({ topic, ms: m.createdAt.getTime() - ask.at.getTime() });
  }

  const ackedMs = escalations
    .filter((e) => e.notifiedAt && e.acknowledgedAt)
    .map((e) => (e.acknowledgedAt as Date).getTime() - (e.notifiedAt as Date).getTime())
    .filter((ms) => ms >= 0);

  const savings = agentSavings({
    closedByTopic: [...closedTopics].map(([topic, count]) => ({ topic, count })),
    manual,
    escalations: escalations.length,
    escalationCostMs: ackedMs.reduce((a, b) => a + b, 0),
  });

  return {
    hasData: runs.length > 0 || messages.length > 0 || escalations.length > 0,
    reliability,
    autonomy,
    escalations: escalationSlices,
    escalationAck,
    responseTime,
    savings,
  };
}
