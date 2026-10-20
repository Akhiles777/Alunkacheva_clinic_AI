"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { requireId } from "@/lib/server/require-id";
import { writeAudit } from "@/lib/server/audit";
import { clinicDayRange, startOfClinicDay } from "@/lib/clinic-time";
import { looksMedical } from "@/lib/agent/gaps";
import { snapshotOf } from "@/lib/metrics/promo-services";
import { runPromoAiReview as runAiReview } from "@/lib/server/promo-ai";
import {
  attachToSchool,
  detachFromSchool,
  newReportToken,
  patientPromoState,
  type AttachResult,
  type PatientPromoState,
  ensureSchoolPromo,
  markParticipantDone,
  revokeParticipantBonus,
  searchPatientsForPromo,
  setParticipantSchool,
  unmarkParticipantDone,
  recomputePartnerBonuses,
} from "@/lib/server/promos";

/**
 * Акции и школы-партнёры.
 *
 * Заводит и правит акции владелец или тот, у кого есть право на настройки;
 * привязывает пациентов к школе тот, кто ведёт переписку. Каждое изменение —
 * в журнал аудита: бонус — это деньги школе, и «кто поставил» должно
 * находиться без расспросов.
 */

const dateKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "дата в формате ГГГГ-ММ-ДД");
const money = z.number().finite().min(0).max(10_000_000);

const PromoInput = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().trim().min(2, "у акции должно быть название").max(120),
    description: z.string().trim().max(2000).nullable(),
    priceTotal: money,
    priceRegular: money,
    ageMin: z.number().int().min(0).max(120).nullable(),
    ageMax: z.number().int().min(0).max(120).nullable(),
    serviceIds: z.array(z.number().int().positive()).max(50),
    startsOn: dateKey,
    endsOn: dateKey,
    bonusAmount: money,
    isActive: z.boolean(),
    agentEnabled: z.boolean(),
  })
  .refine(
    (p) => p.endsOn >= p.startsOn,
    "акция не может закончиться раньше, чем началась",
  )
  .refine(
    (p) => p.ageMin == null || p.ageMax == null || p.ageMin <= p.ageMax,
    "возраст «от» больше, чем «до»",
  );

export type PromoForm = z.input<typeof PromoInput>;

function fail(error: z.ZodError): never {
  throw new Error(error.issues[0]?.message ?? "Проверьте поля формы.");
}

function slugOf(name: string): string {
  const map: Record<string, string> = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "c",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ы: "y",
    э: "e",
    ю: "yu",
    я: "ya",
  };
  const s = name
    .toLowerCase()
    .split("")
    .map((c) => map[c] ?? c)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 60) || "promo";
}

export async function savePromo(form: PromoForm): Promise<{ id: string }> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  const parsed = PromoInput.safeParse(form);
  if (!parsed.success) fail(parsed.error);
  const p = parsed.data;
  // Сутки клиники, а не сервера: «до 15 ноября» — включая весь день 15-го.
  const startsAt = startOfClinicDay(new Date(`${p.startsOn}T12:00:00Z`));
  const endsAt = new Date(
    clinicDayRange(new Date(`${p.endsOn}T12:00:00Z`)).end.getTime() - 1,
  );
  const data = {
    name: p.name,
    description: p.description || null,
    priceTotal: p.priceTotal,
    priceRegular: p.priceRegular,
    ageMin: p.ageMin,
    ageMax: p.ageMax,
    serviceIds: [...new Set(p.serviceIds)],
    startsAt,
    endsAt,
    bonusAmount: p.bonusAmount,
    isActive: p.isActive,
    agentEnabled: p.agentEnabled,
  };
  let id: string;
  if (p.id) {
    const r = await prisma.promo.updateMany({
      where: { id: p.id, companyId: session.companyId },
      data,
    });
    if (!r.count) throw new Error("Акция не найдена.");
    id = p.id;
  } else {
    let slug = slugOf(p.name);
    if (
      await prisma.promo.findFirst({
        where: { companyId: session.companyId, slug },
        select: { id: true },
      })
    ) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }
    id = (
      await prisma.promo.create({
        data: { ...data, slug, companyId: session.companyId },
        select: { id: true },
      })
    ).id;
  }
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "promo",
    entityId: id,
    meta: {
      name: p.name,
      serviceIds: data.serviceIds,
      endsOn: p.endsOn,
      agentEnabled: p.agentEnabled,
      isActive: p.isActive,
    },
  });
  revalidatePath("/promos");
  return { id };
}

const SchoolInput = z.object({
  id: z.string().min(1).optional(),
  promoId: z.string().min(1),
  name: z.string().trim().min(2, "у школы должно быть название").max(160),
  contactName: z.string().trim().max(120).nullable(),
  contactPhone: z.string().trim().max(40).nullable(),
  isActive: z.boolean(),
  /** Как ещё называют школу родители — по этим словам модель узнаёт упоминание. */
  aliases: z.array(z.string().trim().min(2).max(80)).max(20).optional(),
});

export async function saveSchool(
  form: z.input<typeof SchoolInput>,
): Promise<{ id: string }> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  const parsed = SchoolInput.safeParse(form);
  if (!parsed.success) fail(parsed.error);
  const s = parsed.data;
  const promo = await prisma.promo.findFirst({
    where: { id: s.promoId, companyId: session.companyId },
    select: { id: true },
  });
  if (!promo) throw new Error("Акция не найдена.");
  const data = {
    name: s.name,
    contactName: s.contactName || null,
    contactPhone: s.contactPhone || null,
    isActive: s.isActive,
    ...(s.aliases ? { aliases: [...new Set(s.aliases)] } : {}),
  };
  let id: string;
  if (s.id) {
    const r = await prisma.partnerSchool.updateMany({
      where: { id: s.id, companyId: session.companyId },
      data,
    });
    if (!r.count) throw new Error("Школа не найдена.");
    id = s.id;
  } else {
    id = (
      await prisma.partnerSchool.create({
        data: {
          ...data,
          companyId: session.companyId,
          promoId: promo.id,
          reportToken: newReportToken(),
          createdById: session.userId,
        },
        select: { id: true },
      })
    ).id;
  }
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "partner_school",
    entityId: id,
    meta: { name: s.name, isActive: s.isActive },
  });
  revalidatePath("/promos");
  return { id };
}

/** Новая ссылка отчёта: старая перестаёт открываться (переслали не туда). */
export async function rotateSchoolToken(schoolId: string): Promise<void> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  requireId(schoolId, "школа");
  const r = await prisma.partnerSchool.updateMany({
    where: { id: schoolId, companyId: session.companyId },
    data: { reportToken: newReportToken() },
  });
  if (!r.count) throw new Error("Школа не найдена.");
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "partner_school",
    entityId: schoolId,
    meta: { rotatedReportToken: true },
  });
  revalidatePath("/promos");
}

// ─────────────────────────────────────────────── карточка пациента

export async function loadPatientPromos(
  patientId: string,
): Promise<PatientPromoState> {
  const session = await getSession();
  await requirePermission(session, "MESSAGE_PATIENTS");
  requireId(patientId, "пациент");
  return patientPromoState(session.companyId, patientId);
}

const AttachInput = z.object({
  patientId: z.string().min(1),
  // Пусто — пришёл по акции сам, без школы.
  schoolId: z.string().min(1).nullable(),
  conversationId: z.string().min(1).nullable(),
  childName: z.string().trim().max(120).nullable(),
  extraChild: z.boolean(),
});

export async function attachPatientToSchool(
  form: z.input<typeof AttachInput>,
): Promise<AttachResult> {
  const session = await getSession();
  await requirePermission(session, "MESSAGE_PATIENTS");
  const parsed = AttachInput.safeParse(form);
  if (!parsed.success) fail(parsed.error);
  const result = await attachToSchool({
    companyId: session.companyId,
    actorId: session.userId,
    ...parsed.data,
  });
  if (result.ok) {
    await writeAudit({
      companyId: session.companyId,
      actorId: session.userId,
      action: "SETTINGS_UPDATE",
      entityType: "partner_attribution",
      entityId: result.attributionId,
      meta: {
        patientId: parsed.data.patientId,
        schoolId: parsed.data.schoolId,
        extraChild: parsed.data.extraChild,
      },
    });
  }
  return result;
}

export async function detachPatientFromSchool(
  attributionId: string,
): Promise<void> {
  const session = await getSession();
  await requirePermission(session, "MESSAGE_PATIENTS");
  requireId(attributionId, "привязка");
  const done = await detachFromSchool({
    companyId: session.companyId,
    actorId: session.userId,
    attributionId,
  });
  if (!done) throw new Error("Привязка уже снята или не найдена.");
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "partner_attribution",
    entityId: attributionId,
    meta: { removed: true },
  });
}

// ─────────────────────────────────────────────── что агент знает об акции

/**
 * Записи справочника об акции. Правила те же, что у общего справочника (§6):
 * медицинскую запись утверждает врач или владелец, правка текста утверждение
 * снимает и выключает запись. Удаления нет — запись выключают.
 */
const PromoKnowledgeInput = z.object({
  promoId: z.string().min(1),
  id: z.string().min(1).optional(),
  topic: z.string().trim().min(2, "у записи должна быть тема").max(200),
  question: z.string().trim().min(2, "напишите, на какой вопрос отвечает запись").max(500),
  answer: z.string().trim().min(2, "у записи должен быть ответ").max(4000),
  medical: z.boolean(),
});

export async function savePromoKnowledge(form: z.input<typeof PromoKnowledgeInput>): Promise<void> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  const parsed = PromoKnowledgeInput.safeParse(form);
  if (!parsed.success) fail(parsed.error);
  const k = parsed.data;
  const promo = await prisma.promo.findFirst({ where: { id: k.promoId, companyId: session.companyId }, select: { id: true } });
  if (!promo) throw new Error("Акция не найдена.");
  let entityId = k.id ?? null;
  if (k.id) {
    const before = await prisma.knowledgeEntry.findFirst({
      where: { id: k.id, companyId: session.companyId, promoId: promo.id },
      select: { topic: true, question: true, answer: true, needsDoctorApproval: true, approvedAt: true },
    });
    if (!before) throw new Error("Запись не найдена.");
    const changed = before.topic !== k.topic || before.question !== k.question || before.answer !== k.answer;
    // Медицинская отметка — из базы: снять её отправкой формы нельзя.
    const reapprove = before.needsDoctorApproval && before.approvedAt && changed;
    await prisma.knowledgeEntry.update({
      where: { id: k.id },
      data: {
        topic: k.topic,
        question: k.question,
        answer: k.answer,
        updatedById: session.userId,
        ...(reapprove ? { approvedAt: null, approvedById: null, isActive: false } : {}),
      },
    });
  } else {
    const medical = k.medical || looksMedical(`${k.topic} ${k.question} ${k.answer}`);
    entityId = (
      await prisma.knowledgeEntry.create({
        data: {
          companyId: session.companyId,
          promoId: promo.id,
          topic: k.topic,
          question: k.question,
          answer: k.answer,
          needsDoctorApproval: medical,
          // Неутверждённая медицинская запись не включается никогда.
          isActive: !medical,
          updatedById: session.userId,
        },
        select: { id: true },
      })
    ).id;
  }
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "knowledge",
    entityId,
    meta: { promoId: promo.id, edited: Boolean(k.id) },
  });
  revalidatePath("/promos");
}

export async function setPromoKnowledgeActive(id: string, active: boolean): Promise<void> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  requireId(id, "запись");
  const row = await prisma.knowledgeEntry.findFirst({
    where: { id, companyId: session.companyId, promoId: { not: null } },
    select: { promoId: true, needsDoctorApproval: true, approvedAt: true },
  });
  if (!row) throw new Error("Запись не найдена.");
  if (active && row.needsDoctorApproval && !row.approvedAt) {
    throw new Error("Медицинская запись: включить можно после утверждения врачом.");
  }
  await prisma.knowledgeEntry.update({ where: { id }, data: { isActive: active, updatedById: session.userId } });
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "knowledge",
    entityId: id,
    meta: { promoId: row.promoId, active },
  });
  revalidatePath("/promos");
}

/** Утвердить медицинскую запись акции — врач или владелец, как в общем справочнике. */
export async function approvePromoKnowledge(id: string): Promise<void> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  requireId(id, "запись");
  if (session.role !== "DOCTOR" && session.role !== "OWNER") {
    throw new Error("Утвердить медицинскую справку может врач или владелец.");
  }
  const r = await prisma.knowledgeEntry.updateMany({
    where: { id, companyId: session.companyId, promoId: { not: null }, needsDoctorApproval: true },
    data: { approvedAt: new Date(), approvedById: session.userId },
  });
  if (!r.count) throw new Error("Запись не найдена или не требует утверждения.");
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "knowledge",
    entityId: id,
    meta: { approved: true },
  });
  revalidatePath("/promos");
}

// ─────────────────────────────────────────────── одна акция: экран

const ItemInput = z.object({
  title: z.string().trim().min(2).max(200),
  price: z.number().finite().min(0).max(1_000_000),
  yclientsServiceId: z.number().int().positive().nullable(),
});

const SettingsInput = z
  .object({
    name: z.string().trim().min(2, "у акции должно быть название").max(120),
    description: z.string().trim().max(2000).nullable(),
    priceTotal: money,
    priceRegular: money,
    ageMin: z.number().int().min(0).max(120).nullable(),
    ageMax: z.number().int().min(0).max(120).nullable(),
    startsOn: dateKey,
    endsOn: dateKey,
    bonusAmount: money,
    isActive: z.boolean(),
    agentEnabled: z.boolean(),
    items: z.array(ItemInput).max(20),
    waMarker: z.string().trim().min(2, "метка — хотя бы два знака").max(20),
    waPhone: z
      .string()
      .trim()
      .max(20)
      .nullable()
      .refine((v) => !v || v.replace(/\D/g, "").length >= 10, "номер WhatsApp — не меньше 10 цифр"),
    serviceIds: z.array(z.number().int().positive()).max(50),
    serviceKeywords: z.array(z.string().trim().min(3, "ключевое слово — от трёх букв").max(40)).max(10),
    excludedServiceIds: z.array(z.number().int().positive()).max(50),
    aiReviewEnabled: z.boolean(),
  })
  .refine((p) => p.endsOn >= p.startsOn, "акция не может закончиться раньше, чем началась");

/** Условия акции и её состав. Засчитываются визиты по услугам, связанным с позициями. */
export async function saveSchoolPromo(form: z.input<typeof SettingsInput>): Promise<void> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  const parsed = SettingsInput.safeParse(form);
  if (!parsed.success) fail(parsed.error);
  const p = parsed.data;
  const id = await ensureSchoolPromo(session.companyId);
  // Выбранные руками. Позиции состава — для пациента и агента, на засчитывание не влияют.
  const chosen = [...new Set(p.serviceIds)];
  const catalog = await prisma.service.findMany({
    where: { companyId: session.companyId, yclientsServiceId: { in: chosen } },
    select: { yclientsServiceId: true, title: true, isActive: true },
  });
  await prisma.promo.update({
    where: { id },
    data: {
      name: p.name,
      description: p.description || null,
      priceTotal: p.priceTotal,
      priceRegular: p.priceRegular,
      ageMin: p.ageMin,
      ageMax: p.ageMax,
      startsAt: startOfClinicDay(new Date(`${p.startsOn}T12:00:00Z`)),
      endsAt: new Date(clinicDayRange(new Date(`${p.endsOn}T12:00:00Z`)).end.getTime() - 1),
      bonusAmount: p.bonusAmount,
      isActive: p.isActive,
      agentEnabled: p.agentEnabled,
      items: p.items as unknown as object[],
      serviceIds: chosen,
      serviceSnapshot: snapshotOf(chosen, catalog),
      waMarker: p.waMarker,
      waPhone: p.waPhone ? p.waPhone.replace(/\D/g, "") : null,
      serviceKeywords: [...new Set(p.serviceKeywords.map((k) => k.toLowerCase()))],
      excludedServiceIds: [...new Set(p.excludedServiceIds)],
      aiReviewEnabled: p.aiReviewEnabled,
    },
  });
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "promo",
    entityId: id,
    meta: {
      items: p.items.length,
      services: chosen.length,
      keywords: p.serviceKeywords,
      agentEnabled: p.agentEnabled,
      aiReviewEnabled: p.aiReviewEnabled,
      isActive: p.isActive,
      endsOn: p.endsOn,
    },
  });
  // Состав и сроки решают, какие визиты засчитываются, — бонусы пересчитываем сразу, а не через круг выгрузки.
  await recomputePartnerBonuses(session.companyId);
  revalidatePath("/promos");
}

export async function findPatientsForPromo(q: string): Promise<{ id: string; name: string; phoneTail: string | null }[]> {
  const session = await getSession();
  await requirePermission(session, "MESSAGE_PATIENTS");
  return searchPatientsForPromo(session.companyId, String(q ?? "").slice(0, 100));
}

async function participantAction(
  attributionId: string,
  what: string,
  run: (companyId: string, actorId: string | null) => Promise<void>,
): Promise<void> {
  const session = await getSession();
  await requirePermission(session, "MESSAGE_PATIENTS");
  requireId(attributionId, "участник");
  await run(session.companyId, session.userId);
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "partner_attribution",
    entityId: attributionId,
    meta: { action: what },
  });
  revalidatePath("/promos");
}

/** «Прошёл всё» — руками; есть школа — бонус ставится сразу. */
export async function markPromoDone(attributionId: string): Promise<void> {
  await participantAction(attributionId, "done", (c, a) => markParticipantDone(c, a, attributionId));
}

export async function unmarkPromoDone(attributionId: string): Promise<void> {
  await participantAction(attributionId, "undone", (c, a) => unmarkParticipantDone(c, a, attributionId));
}

export async function revokePromoBonus(attributionId: string, reason: string | null): Promise<void> {
  await participantAction(attributionId, "revoke_bonus", (c, a) => revokeParticipantBonus(c, a, attributionId, reason));
}

export async function setPromoParticipantSchool(attributionId: string, schoolId: string | null): Promise<void> {
  await participantAction(attributionId, "set_school", (c, a) => setParticipantSchool(c, a, attributionId, schoolId));
}

/**
 * Привязка «на проверке» (улика из переписки) — подтвердить или отклонить.
 * Решает человек: администратор или владелец. Подтверждённая начисляет бонус по
 * обычному правилу (визит «пришёл»); отклонённая — окончательно, модель этого
 * пациента больше не проверяет. Подтвердить можно и после конца акции.
 */
export async function reviewPromoAttribution(attributionId: string, decision: "confirm" | "reject"): Promise<void> {
  const session = await getSession();
  await requirePermission(session, "MESSAGE_PATIENTS");
  requireId(attributionId, "привязка");
  if (session.role !== "ADMIN" && session.role !== "OWNER") {
    throw new Error("Подтвердить или отклонить привязку может администратор или владелец.");
  }
  if (decision !== "confirm" && decision !== "reject") throw new Error("Неизвестное решение.");
  const r = await prisma.partnerAttribution.updateMany({
    where: { id: attributionId, companyId: session.companyId, reviewStatus: "REVIEW", removedAt: null },
    data: {
      reviewStatus: decision === "confirm" ? "CONFIRMED" : "REJECTED",
      reviewedById: session.userId,
      reviewedAt: new Date(),
    },
  });
  if (!r.count) throw new Error("Привязка не найдена или уже разобрана.");
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "partner_attribution",
    entityId: attributionId,
    meta: { review: decision },
  });
  await recomputePartnerBonuses(session.companyId);
  revalidatePath("/promos");
}

/** «Проверить сейчас»: тот же разбор, что ночью, одной порцией. Отвечает словами. */
export async function runPromoAiReview(): Promise<string> {
  const session = await getSession();
  await requirePermission(session, "MESSAGE_PATIENTS");
  if (session.role !== "ADMIN" && session.role !== "OWNER") throw new Error("Запустить разбор может администратор или владелец.");
  const r = await runAiReview(session.companyId);
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "promo",
    entityId: null,
    meta: { aiReview: { checked: r.checked, attributed: r.attributed } },
  });
  revalidatePath("/promos");
  if (r.skipped) return `Не запущено: ${r.skipped}.`;
  if (r.checked === 0) return r.candidates ? "Новых переписок для проверки нет." : "Проверять некого: нет новых пациентов с визитом акции без привязки.";
  return `Проверено переписок: ${r.checked}; на проверку ушло: ${r.attributed}.`;
}
