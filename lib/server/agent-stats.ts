import { prisma } from "@/lib/db";
import { periodBounds } from "@/lib/server/analytics";
import type { PeriodKey } from "@/lib/metrics/types";
import {
  agentAssist,
  agentAutonomy,
  agentReliability,
  closedByAgent,
  escalationBreakdown,
  type AgentAutonomy,
  type AgentReliability,
  type AgentAssist,
  type AssistDialog,
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
import { agentSavings, waitingSaved, type SavingsReport, type WaitingSaved } from "@/lib/metrics/agent-savings";
import { confidentMatch, matchKnowledge, type KnowledgeRow } from "@/lib/agent/knowledge";
import { looksLikeIntake } from "@/lib/agent/intake";
import { BOOKING_WINDOW_MS } from "@/lib/metrics/agent";

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
  /**
   * Снятое с пациентов ожидание — вторая мера пользы, считается из двух
   * измеренных медиан без единой придуманной величины.
   */
  waiting: WaitingSaved;
  /**
   * Работа агента по реальной схеме: оформил заявку — передал — записали.
   * «Закрыл сам» отвечает на другой вопрос и остаётся рядом.
   */
  assist: AgentAssist;
  /**
   * С какого момента ведётся журнал попыток. Без этой даты прочерк в
   * «Надёжности» читается как поломка, а означает «журнала тогда не было».
   */
  logSince: Date | null;
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
   *
   * Два ограничения — ради скорости кабинета владельца, а не ради экономии
   * памяти. Раньше здесь читались ВСЕ сообщения клиники за квартал вместе с
   * телами, и каждый ручной ответ сверялся со ВСЕМ справочником: сотни
   * записей на тысячу пар — это секунды процессорного времени на каждое
   * открытие страницы.
   *
   *   — если агент не закрыл ни одного разговора с известной темой, сравнивать
   *     не с чем, и читать переписку незачем вовсе;
   *   — сверяем только с теми записями справочника, чьи темы агент закрывал:
   *     остальные не могут дать совпадение, которое кому-то нужно.
   */
  const manual: { topic: string; ms: number }[] = [];
  if (closedTopics.size > 0) {
    const relevant = knowledge.filter((k) => closedTopics.has(k.topic));
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

    const pending = new Map<string, { at: Date; body: string }>();
    for (const m of manualRows) {
      if (m.authorType === "PATIENT") {
        if (!pending.has(m.conversationId)) pending.set(m.conversationId, { at: m.createdAt, body: m.body });
        continue;
      }
      const ask = pending.get(m.conversationId);
      if (!ask) continue;
      pending.delete(m.conversationId);
      const topic = topicOf(ask.body, relevant);
      if (!topic) continue;
      manual.push({ topic, ms: m.createdAt.getTime() - ask.at.getTime() });
    }
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

  /**
   * Работа по реальной схеме: агент оформил заявку — передал администратору —
   * тот записал. Считается по тем же диалогам периода.
   */
  const assist = await assistOf(companyId, messages, escalations, from, to);

  /** С какого момента журнал вообще ведётся: прочерк без даты — не число. */
  const firstRun = await prisma.agentRun.findFirst({
    where: { companyId },
    orderBy: { triggeredAt: "asc" },
    select: { triggeredAt: true },
  });

  return {
    hasData: runs.length > 0 || messages.length > 0 || escalations.length > 0,
    reliability,
    autonomy,
    escalations: escalationSlices,
    escalationAck,
    responseTime,
    savings,
    waiting: waitingSaved({
      agent: { medianMs: responseTime.agent.medianMs, count: responseTime.agent.count },
      manualWorkingHours: {
        medianMs: responseTime.staffWorkingHours.medianMs,
        count: responseTime.staffWorkingHours.count,
      },
    }),
    assist,
    logSince: firstRun?.triggeredAt ?? null,
  };
}

/**
 * Диалоги для метрики «оформил заявку».
 *
 * Данные для записи узнаём тем же правилом, что и агент (`looksLikeIntake`):
 * имя из нескольких слов и число рядом. Второе определение здесь означало бы,
 * что агент считает заявкой одно, а отчёт — другое.
 */
async function assistOf(
  companyId: string,
  messages: {
    conversationId: string;
    direction: string;
    authorType: string;
    body: string;
    createdAt: Date;
  }[],
  escalations: { conversationId: string; createdAt: Date }[],
  from: Date,
  to: Date,
): Promise<AgentAssist> {
  const byDialog = new Map<string, AssistDialog>();
  const ensure = (conversationId: string): AssistDialog => {
    const found = byDialog.get(conversationId);
    if (found) return found;
    const created: AssistDialog = {
      conversationId,
      agentReplied: false,
      intakeAt: null,
      handedOverAt: null,
      bookedAt: null,
    };
    byDialog.set(conversationId, created);
    return created;
  };

  for (const m of messages) {
    const d = ensure(m.conversationId);
    if (m.direction === "OUT" && m.authorType === "BOT") {
      d.agentReplied = true;
      continue;
    }
    /**
     * Данные для записи засчитываем только ПОСЛЕ ответа агента: пациент,
     * приславший ФИО первым сообщением, оформил себя сам.
     */
    if (m.direction === "IN" && m.authorType === "PATIENT" && d.agentReplied && !d.intakeAt) {
      if (looksLikeIntake(m.body)) d.intakeAt = m.createdAt;
      continue;
    }
    if (m.direction === "OUT" && m.authorType === "STAFF" && d.intakeAt && !d.handedOverAt) {
      d.handedOverAt = m.createdAt;
    }
  }

  // Эскалация — тоже передача человеку, и часто она раньше его ответа.
  for (const e of escalations) {
    const d = byDialog.get(e.conversationId);
    if (!d || !d.intakeAt) continue;
    if (e.createdAt < d.intakeAt) continue;
    if (!d.handedOverAt || e.createdAt < d.handedOverAt) d.handedOverAt = e.createdAt;
  }

  const prepared = [...byDialog.values()].filter((d) => d.intakeAt && d.handedOverAt);
  if (prepared.length > 0) {
    /**
     * Записи ищем по пациенту диалога: заявку оформляют в переписке, а запись
     * администратор заводит в YCLIENTS, и связи между ними нет никакой, кроме
     * человека и времени.
     */
    const convs = await prisma.conversation.findMany({
      where: { id: { in: prepared.map((d) => d.conversationId) }, patientId: { not: null } },
      select: { id: true, patientId: true },
    });
    const patientOf = new Map(convs.map((c) => [c.id, c.patientId as string]));
    const patientIds = [...new Set([...patientOf.values()])];

    if (patientIds.length > 0) {
      const appts = await prisma.appointment.findMany({
        where: {
          companyId,
          deletedAt: null,
          status: { not: "CANCELLED" },
          patientId: { in: patientIds },
          createdAtYclients: { gte: from, lt: new Date(to.getTime() + BOOKING_WINDOW_MS) },
        },
        select: { patientId: true, createdAtYclients: true },
        orderBy: { createdAtYclients: "asc" },
      });
      for (const d of prepared) {
        const patientId = patientOf.get(d.conversationId);
        if (!patientId || !d.handedOverAt) continue;
        const hit = appts.find(
          (a) => a.patientId === patientId && a.createdAtYclients >= (d.handedOverAt as Date),
        );
        d.bookedAt = hit?.createdAtYclients ?? null;
      }
    }
  }

  return agentAssist([...byDialog.values()]);
}
