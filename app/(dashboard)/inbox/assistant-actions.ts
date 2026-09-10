"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { requireId } from "@/lib/server/require-id";
import { writeAudit } from "@/lib/server/audit";
import { startOfClinicDay } from "@/lib/clinic-time";
import { briefOf, type BriefFacts } from "@/lib/metrics/dialog-brief";
import { draftWarnings, type DraftWarning } from "@/lib/agent/draft-warnings";
import { patientServices } from "@/lib/agent/price-list";

/**
 * Ассистент АДМИНИСТРАТОРА: справка по запросу и страховка от ошибки.
 *
 * Он не пишет за человека и ничего не отправляет пациенту — это не
 * suggest-режим, который в проекте намеренно пропущен. Его ответы не попадают
 * в `Message` и в переписке не видны никогда.
 *
 * Ни сводка, ни подсказки не уходят во внешнюю модель: переписка с клиникой —
 * врачебная тайна (§7). Всё считается здесь, нашим кодом, из своих данных.
 */

export interface DialogBriefView {
  lines: string[];
  topics: string[];
}

/**
 * Сводка переписки: кто это, что было, чем закончилось.
 *
 * Просмотр карточки пациента фиксируется в журнале (§7): ассистент — тот же
 * доступ к медицинским сведениям, что и открытая карточка, и он должен быть
 * виден в аудите так же.
 */
export async function dialogBriefAction(conversationId: string): Promise<DialogBriefView> {
  requireId(conversationId, "диалог");
  const session = await getSession();

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId: session.companyId, deletedAt: null },
    select: {
      id: true,
      patientId: true,
      isPractice: true,
      messages: {
        where: { deletedAt: null, isDraft: false },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { direction: true, authorType: true, body: true, createdAt: true },
      },
      escalations: {
        where: { status: { not: "RESOLVED" } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { reason: true },
      },
    },
  });
  if (!conv || conv.isPractice) return { lines: [], topics: [] };

  /**
   * Врач видит только своих пациентов — то же правило, что и в карточке.
   * Через ассистента нельзя получить то, что не видно в интерфейсе.
   */
  if (conv.patientId && !(await can(session, "VIEW_OTHER_PATIENTS"))) {
    /**
     * Своим считается пациент, который был у этого специалиста, — та же
     * область видимости, что у карточки. Учётка без привязки к специалисту
     * чужих пациентов не видит вовсе.
     */
    const me = session.userId
      ? await prisma.staffUser.findUnique({
          where: { id: session.userId },
          select: { staffId: true },
        })
      : null;
    if (!me?.staffId) return { lines: [], topics: [] };
    const mine = await prisma.appointment.findFirst({
      where: {
        companyId: session.companyId,
        patientId: conv.patientId,
        staffId: me.staffId,
      },
      select: { id: true },
    });
    if (!mine) return { lines: [], topics: [] };
  }

  const facts: BriefFacts = {
    messages: conv.messages.map((m) => ({
      direction: m.direction === "IN" ? "IN" : "OUT",
      fromBot: m.authorType === "BOT",
      text: m.body,
      at: m.createdAt,
    })),
    visits: 0,
    lastVisitAt: null,
    nextVisitAt: null,
    course: null,
    escalationReason: conv.escalations[0]?.reason ?? null,
  };

  if (conv.patientId) {
    const [visits, next, course] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          companyId: session.companyId,
          patientId: conv.patientId,
          deletedAt: null,
          status: "ARRIVED",
        },
        orderBy: { startAt: "desc" },
        take: 1,
        select: { startAt: true },
      }),
      prisma.appointment.findFirst({
        where: {
          companyId: session.companyId,
          patientId: conv.patientId,
          deletedAt: null,
          status: { in: ["CREATED", "CONFIRMED"] },
          startAt: { gte: new Date() },
        },
        orderBy: { startAt: "asc" },
        select: { startAt: true },
      }),
      prisma.course.findFirst({
        where: { companyId: session.companyId, patientId: conv.patientId, status: "ACTIVE" },
        select: { sessionsUsed: true, sessionsTotal: true, service: { select: { title: true } } },
      }),
    ]);
    const total = await prisma.appointment.count({
      where: {
        companyId: session.companyId,
        patientId: conv.patientId,
        deletedAt: null,
        status: "ARRIVED",
      },
    });
    facts.visits = total;
    facts.lastVisitAt = visits[0]?.startAt ?? null;
    facts.nextVisitAt = next?.startAt ?? null;
    facts.course = course
      ? { title: course.service.title, used: course.sessionsUsed, total: course.sessionsTotal }
      : null;

    await writeAudit({
      companyId: session.companyId,
      actorId: session.userId,
      action: "PATIENT_VIEW",
      entityType: "assistant_brief",
      entityId: conv.patientId,
    }).catch(() => {
      // Журнал не должен ронять справку, но и молчать о сбое незачем.
    });
  }

  const brief = briefOf(facts);
  return { lines: brief.lines, topics: brief.topics };
}

/**
 * Что заметить в ответе до отправки.
 *
 * Никогда не блокирует отправку: администратор знает ситуацию лучше системы.
 * Правила — в `lib/agent/draft-warnings.ts`, там же тесты.
 */
export async function draftWarningsAction(
  conversationId: string,
  text: string,
): Promise<DraftWarning[]> {
  requireId(conversationId, "диалог");
  const session = await getSession();
  if (text.trim().length < 3) return [];

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, companyId: session.companyId, deletedAt: null },
    select: { patientId: true, isPractice: true },
  });
  if (!conv || conv.isPractice) return [];

  const day = startOfClinicDay(new Date());
  const dayEnd = new Date(day.getTime() + 24 * 3600 * 1000);

  const [services, rooms, busy, future, knowledge] = await Promise.all([
    prisma.service.findMany({
      where: { companyId: session.companyId, isActive: true },
      select: { id: true, title: true, price: true, kind: true, durationMin: true },
    }),
    prisma.room.count({ where: { companyId: session.companyId, isActive: true } }),
    prisma.appointment.findMany({
      where: {
        companyId: session.companyId,
        deletedAt: null,
        status: { notIn: ["CANCELLED"] },
        startAt: { gte: day, lt: dayEnd },
      },
      select: { startAt: true, endAt: true },
    }),
    conv.patientId
      ? prisma.appointment.findFirst({
          where: {
            companyId: session.companyId,
            patientId: conv.patientId,
            deletedAt: null,
            status: { in: ["CREATED", "CONFIRMED"] },
            startAt: { gte: new Date() },
          },
          select: { id: true },
        })
      : Promise.resolve(null),
    prisma.knowledgeEntry.findMany({
      where: { companyId: session.companyId, isActive: true },
      select: { topic: true, answer: true },
      take: 100,
    }),
  ]);

  /**
   * Занятость по часам: время считается занятым, только если заняты ВСЕ
   * кабинеты. Иначе подсказка срабатывала бы на каждое время, когда идёт хоть
   * один приём, и её перестали бы читать.
   */
  const freeAt: Record<string, boolean> = {};
  if (rooms > 0) {
    for (let minute = 8 * 60; minute <= 21 * 60; minute += 30) {
      const at = new Date(day.getTime() + minute * 60_000);
      const overlapping = busy.filter((b) => b.startAt <= at && b.endAt > at).length;
      const key = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      freeAt[key] = overlapping < rooms;
    }
  }

  /**
   * Готовый ответ клиники подбираем по совпадению слов темы с текстом: точный
   * поиск здесь не нужен, подсказка лишь напоминает, что текст уже написан.
   */
  const low = text.toLowerCase();
  const match =
    knowledge.find((k) =>
      k.topic
        .toLowerCase()
        .split(/[^а-яёa-z0-9]+/i)
        .filter((w) => w.length > 4)
        .some((w) => low.includes(w)),
    ) ?? null;

  return draftWarnings(text, {
    prices: patientServices(
      services.map((s) => ({
        id: s.id,
        title: s.title,
        price: Number(s.price),
        kind: s.kind,
        durationMin: s.durationMin,
      })),
    ).map((s) => ({ title: s.title, price: s.price })),
    freeAt,
    hasFutureBooking: future !== null,
    knowledgeAnswer: match ? { topic: match.topic, answer: match.answer } : null,
  });
}
