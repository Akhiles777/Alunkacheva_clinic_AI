import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { BASE_URL, modelParams } from "@/lib/agent/llm";
import { graceEnd } from "@/lib/metrics/partner-bonus";
import { buildEvidenceInput, evidencePrompt, parseEvidenceAnswer, verifyEvidence } from "@/lib/metrics/promo-evidence";
import { promoServiceSet, snapshotFrom } from "@/lib/metrics/promo-services";

/**
 * Разбор переписки, если метку из ссылки стёрли (п. 6 спецификации акции).
 *
 * Кого смотрим — только всех условий сразу: новый пациент (клиника не знала
 * его до начала акции), визит акции «пришёл», привязки по акции нет никакой
 * (ни действующей, ни снятой, ни отклонённой), есть переписка WhatsApp,
 * начатая в период акции. Больше никого модель не трогает.
 *
 * Отдельная очередь, НЕ путь пациентского агента: ни одной записи в
 * Conversation, Message, статус диалога и паузу агента. Результат — строка
 * журнала AiAttributionCheck и, если улика подтверждена кодом, привязка «на
 * проверке»: бонус начислится только после «Подтвердить» человеком.
 *
 * Модель — та же дешёвая, что у бота (Haiku 5.5, рассуждение «low»): вопрос
 * один и простой, а траты на модель заказчик считает внимательно.
 */

export const AI_BATCH = Number(process.env.PROMO_AI_BATCH ?? 10);
const MAX_TRIES = 3;
const TIMEOUT_MS = 30_000;

export interface PromoAiRun {
  candidates: number;
  checked: number;
  attributed: number;
  skipped: string | null;
}

export async function runPromoAiReview(companyId: string, now = new Date(), limit = AI_BATCH): Promise<PromoAiRun> {
  const key = process.env.ROUTER_AI;
  if (!key) return { candidates: 0, checked: 0, attributed: 0, skipped: "нет ключа модели" };
  const promo = await prisma.promo.findFirst({
    where: { companyId, aiReviewEnabled: true },
    orderBy: { createdAt: "asc" },
    include: { schools: { where: { isActive: true }, orderBy: { createdAt: "asc" }, take: 1 } },
  });
  if (!promo) return { candidates: 0, checked: 0, attributed: 0, skipped: "разбор переписки выключен" };
  const school = promo.schools[0];
  if (!school) return { candidates: 0, checked: 0, attributed: 0, skipped: "у акции нет школы" };
  if (now.getTime() > graceEnd(promo).getTime()) return { candidates: 0, checked: 0, attributed: 0, skipped: "акция давно закончилась" };

  const catalog = await prisma.service.findMany({
    where: { companyId, yclientsServiceId: { not: null } },
    select: { yclientsServiceId: true, title: true, isActive: true },
  });
  const ids = promoServiceSet(
    {
      serviceIds: promo.serviceIds,
      serviceKeywords: promo.serviceKeywords,
      excludedServiceIds: promo.excludedServiceIds,
      serviceSnapshot: snapshotFrom(promo.serviceSnapshot),
    },
    catalog,
  ).ids;
  if (ids.length === 0) return { candidates: 0, checked: 0, attributed: 0, skipped: "у акции нет услуг" };

  // Пришедшие на услугу акции в её срок.
  const arrived = await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      status: "ARRIVED",
      startAt: { gte: promo.startsAt, lte: graceEnd(promo) },
      services: { some: { service: { yclientsServiceId: { in: ids } } } },
    },
    select: { patientId: true },
    distinct: ["patientId"],
  });
  let pool = arrived.map((a) => a.patientId);
  if (pool.length === 0) return { candidates: 0, checked: 0, attributed: 0, skipped: null };

  // Без привязки — никакой: решение человека (снял, отклонил) модель не пересматривает.
  const attributed = new Set(
    (await prisma.partnerAttribution.findMany({ where: { promoId: promo.id, patientId: { in: pool } }, select: { patientId: true } })).map((a) => a.patientId),
  );
  pool = pool.filter((id) => !attributed.has(id));
  // Новые: карточка не раньше начала акции и ни одной записи раньше него.
  const [early, earlyVisits] = await Promise.all([
    prisma.patient.findMany({ where: { id: { in: pool }, firstSeenAt: { lt: promo.startsAt } }, select: { id: true } }),
    prisma.appointment.findMany({
      where: { companyId, patientId: { in: pool }, deletedAt: null, startAt: { lt: promo.startsAt } },
      select: { patientId: true },
      distinct: ["patientId"],
    }),
  ]);
  const known = new Set([...early.map((p) => p.id), ...earlyVisits.map((v) => v.patientId)]);
  pool = pool.filter((id) => !known.has(id));

  const conversations = await prisma.conversation.findMany({
    where: { companyId, patientId: { in: pool }, channel: "WHATSAPP", isPractice: false, startedAt: { gte: promo.startsAt } },
    orderBy: { startedAt: "asc" },
    select: { id: true, patientId: true, patient: { select: { name: true } } },
  });
  const firstConv = new Map<string, (typeof conversations)[number]>();
  for (const c of conversations) if (c.patientId && !firstConv.has(c.patientId)) firstConv.set(c.patientId, c);

  const past = await prisma.aiAttributionCheck.findMany({
    where: { promoId: promo.id, patientId: { in: [...firstConv.keys()] } },
    select: { patientId: true, inputHash: true, result: true },
  });

  let checked = 0;
  let made = 0;
  for (const [patientId, conv] of firstConv) {
    if (checked >= limit) break;
    const mine = past.filter((c) => c.patientId === patientId);
    if (mine.length >= MAX_TRIES) continue;

    const messages = await prisma.message.findMany({
      where: { conversationId: conv.id, deletedAt: null },
      orderBy: { createdAt: "asc" },
      take: 40,
      select: { id: true, direction: true, authorType: true, body: true, createdAt: true },
    });
    const input = buildEvidenceInput(messages, school.name, school.aliases, conv.patient?.name ? [conv.patient.name] : []);
    if (input.lines.length === 0) continue;
    const prompt = evidencePrompt(input);
    const inputHash = createHash("sha256").update(`${prompt.system}\n${prompt.user}`).digest("hex");
    // Тот же ввод уже проверен и ответ был — повторять нечего. Ошибка модели — повторяем следующей ночью.
    if (mine.some((c) => c.inputHash === inputHash && c.result !== "MODEL_ERROR")) continue;

    checked += 1;
    const raw = await ask(key, prompt);
    const answer = raw === null ? null : parseEvidenceAnswer(raw);
    const model = modelParams().model;
    if (!answer) {
      await prisma.aiAttributionCheck.create({
        data: { companyId, promoId: promo.id, patientId, conversationId: conv.id, inputHash, result: "MODEL_ERROR", reason: raw === null ? "модель не ответила" : "ответ не по форме", model },
      });
      continue;
    }
    const verdict = verifyEvidence(answer, input);
    await prisma.aiAttributionCheck.create({
      data: {
        companyId,
        promoId: promo.id,
        patientId,
        conversationId: conv.id,
        inputHash,
        result: verdict.result,
        evidenceMessageId: verdict.result === "ATTRIBUTED" ? verdict.messageId : null,
        evidenceQuote: verdict.result === "ATTRIBUTED" ? verdict.quote : null,
        reason: verdict.result === "ATTRIBUTED" ? (answer.reason || null) : verdict.reason,
        model,
      },
    });
    if (verdict.result !== "ATTRIBUTED") continue;
    /**
     * Привязка «на проверке». Момент привязки — сообщение-улика: бонус берёт
     * визит не раньше привязки, а визит здесь уже состоялся, и момент разбора
     * отрезал бы его всегда.
     */
    const ok = await prisma.partnerAttribution
      .create({
        data: {
          companyId,
          promoId: promo.id,
          patientId,
          schoolId: school.id,
          conversationId: conv.id,
          source: "AGENT",
          confidence: "AI_EVIDENCE",
          reviewStatus: "REVIEW",
          evidenceMessageId: verdict.messageId,
          evidenceQuote: verdict.quote,
          bonusAmountFrozen: promo.bonusAmount,
          attributedAt: verdict.at,
          childNo: 1,
        },
      })
      .then(() => true)
      .catch(() => false);
    if (ok) made += 1;
  }
  return { candidates: firstConv.size, checked, attributed: made, skipped: null };
}

async function ask(key: string, prompt: { system: string; user: string }): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        ...modelParams(),
        temperature: 0,
        max_tokens: 600,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
