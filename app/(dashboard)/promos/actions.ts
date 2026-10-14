"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { requireId } from "@/lib/server/require-id";
import { writeAudit } from "@/lib/server/audit";
import { clinicDayRange, startOfClinicDay } from "@/lib/clinic-time";
import {
  attachToSchool,
  detachFromSchool,
  newReportToken,
  patientPromoState,
  type AttachResult,
  type PatientPromoState,
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
  revalidatePath(`/schools/${schoolId}`);
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
  schoolId: z.string().min(1),
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
