import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { clinicDateKey, clinicDayRange, startOfClinicDay } from "@/lib/clinic-time";
import {
  bonusActions,
  canAttribute,
  graceEnd,
  schoolTotals,
  type AttributionFact,
  type BonusAction,
  type SchoolTotals,
  type VisitFact,
} from "@/lib/metrics/partner-bonus";

/**
 * Акции и школы-партнёры: данные экранов, привязка пациентов и пересчёт
 * бонусов. Правило бонуса — в `lib/metrics/partner-bonus.ts`; здесь только
 * факты из базы и запись результата.
 */

const num = (d: { toString(): string } | null | undefined) =>
  d == null ? 0 : Number(d.toString());

export function newReportToken(): string {
  return randomBytes(32).toString("base64url");
}

// ─────────────────────────────────────────────── пересчёт бонусов

/**
 * Пересчитать бонусы по всем акциям клиники. Идемпотентно: идёт после каждой
 * выгрузки YCLIENTS, и повтор на тех же фактах ничего не меняет.
 */
export async function recomputePartnerBonuses(
  companyId: string,
  now = new Date(),
  options: { dryRun?: boolean; plan?: BonusAction[] } = {},
): Promise<{ earned: number; reversed: number }> {
  const promos = await prisma.promo.findMany({
    where: { companyId },
    select: { id: true, serviceIds: true, startsAt: true, endsAt: true },
  });
  let earned = 0;
  let reversed = 0;
  for (const promo of promos) {
    const attributions = await prisma.partnerAttribution.findMany({
      where: { companyId, promoId: promo.id },
      select: {
        id: true,
        schoolId: true,
        patientId: true,
        childNo: true,
        attributedAt: true,
        removedAt: true,
        completedAt: true,
        bonusAmountFrozen: true,
        bonus: {
          select: {
            id: true,
            status: true,
            triggeredByAppointmentId: true,
            reversedAt: true,
            manual: true,
          },
        },
      },
    });
    // Всё решено и снять нечего — к записям не ходим.
    const open = attributions.filter(
      (a) =>
        !a.bonus ||
        a.bonus.status === "EARNED" ||
        (a.bonus.reversedAt && a.attributedAt > a.bonus.reversedAt),
    );
    if (!open.length) continue;
    const patientIds = [...new Set(open.map((a) => a.patientId))];
    const visits = await prisma.appointment.findMany({
      where: {
        companyId,
        patientId: { in: patientIds },
        startAt: { gte: promo.startsAt, lte: graceEnd(promo) },
      },
      select: {
        id: true,
        patientId: true,
        startAt: true,
        status: true,
        deletedAt: true,
        services: {
          select: {
            quantity: true,
            service: { select: { yclientsServiceId: true } },
          },
        },
      },
    });
    // Основание начисленного бонуса могло уехать за окно — его тоже нужно видеть.
    const triggerIds = open
      .map((a) => a.bonus?.triggeredByAppointmentId)
      .filter((x): x is string => Boolean(x));
    const missing = triggerIds.filter((id) => !visits.some((v) => v.id === id));
    if (missing.length) {
      visits.push(
        ...(await prisma.appointment.findMany({
          where: { companyId, id: { in: missing } },
          select: {
            id: true,
            patientId: true,
            startAt: true,
            status: true,
            deletedAt: true,
            services: {
              select: {
                quantity: true,
                service: { select: { yclientsServiceId: true } },
              },
            },
          },
        })),
      );
    }

    for (const patientId of patientIds) {
      const mine = attributions.filter((a) => a.patientId === patientId);
      const facts: AttributionFact[] = mine.map((a) => ({
        id: a.id,
        childNo: a.childNo,
        attributedAt: a.attributedAt,
        removed: a.removedAt != null,
        bonusAmountFrozen: num(a.bonusAmountFrozen),
        hasSchool: a.schoolId != null,
        completed: a.completedAt != null,
        bonus: a.bonus
          ? {
              id: a.bonus.id,
              status: a.bonus.status,
              triggeredByAppointmentId: a.bonus.triggeredByAppointmentId,
              reversedAt: a.bonus.reversedAt,
              manual: a.bonus.manual,
            }
          : null,
      }));
      const visitFacts: VisitFact[] = visits
        .filter((v) => v.patientId === patientId)
        .map((v) => ({
          id: v.id,
          startAt: v.startAt,
          status: v.status,
          deleted: v.deletedAt != null,
          services: v.services.map((s) => ({
            yclientsServiceId: s.service.yclientsServiceId,
            quantity: s.quantity,
          })),
        }));
      for (const act of bonusActions(promo, facts, visitFacts)) {
        options.plan?.push(act);
        // Сухой прогон: только считаем, что изменилось бы.
        if (options.dryRun) {
          if (act.kind === "earn") earned += 1;
          else reversed += 1;
          continue;
        }
        if (act.kind === "earn" && act.bonusId) {
          const r = await prisma.partnerBonus.updateMany({
            where: { id: act.bonusId, status: "REVERSED" },
            data: {
              status: "EARNED",
              triggeredByAppointmentId: act.appointmentId,
              earnedAt: act.earnedAt,
              amount: act.amount,
              reversedAt: null,
              reverseReason: null,
            },
          });
          earned += r.count;
        } else if (act.kind === "earn") {
          const a = mine.find((x) => x.id === act.attributionId)!;
          if (!a.schoolId) continue;
          // Уникальность по привязке держит база: параллельный круг не задвоит.
          const created = await prisma.partnerBonus
            .create({
              data: {
                companyId,
                schoolId: a.schoolId,
                attributionId: a.id,
                amount: act.amount,
                status: "EARNED",
                triggeredByAppointmentId: act.appointmentId,
                earnedAt: act.earnedAt,
              },
            })
            .then(() => true)
            .catch(() => false);
          if (created) earned += 1;
        } else {
          const r = await prisma.partnerBonus.updateMany({
            where: { id: act.bonusId, status: "EARNED" },
            data: {
              status: "REVERSED",
              reversedAt: now,
              reverseReason: act.reason,
            },
          });
          reversed += r.count;
        }
      }
    }
  }
  return { earned, reversed };
}

// ─────────────────────────────────────────────── экраны клиники

export interface PromoListRow {
  id: string;
  name: string;
  endsAt: string;
  isActive: boolean;
  agentEnabled: boolean;
  open: boolean;
  schools: number;
  totals: SchoolTotals;
}

async function totalsFor(where: {
  companyId: string;
  promoId?: string;
  schoolId?: string;
}): Promise<SchoolTotals> {
  const rows = await prisma.partnerAttribution.findMany({
    where,
    select: {
      removedAt: true,
      bonus: { select: { status: true, amount: true } },
    },
  });
  return schoolTotals(
    rows.map((r) => ({
      removed: r.removedAt != null,
      bonus: r.bonus
        ? { status: r.bonus.status, amount: num(r.bonus.amount) }
        : null,
    })),
  );
}

export async function listPromos(
  companyId: string,
  now = new Date(),
): Promise<PromoListRow[]> {
  const promos = await prisma.promo.findMany({
    where: { companyId },
    orderBy: { endsAt: "desc" },
    select: {
      id: true,
      name: true,
      endsAt: true,
      isActive: true,
      agentEnabled: true,
      _count: { select: { schools: true } },
    },
  });
  return Promise.all(
    promos.map(async (p) => ({
      id: p.id,
      name: p.name,
      endsAt: p.endsAt.toISOString(),
      isActive: p.isActive,
      agentEnabled: p.agentEnabled,
      open: canAttribute(p, now),
      schools: p._count.schools,
      totals: await totalsFor({ companyId, promoId: p.id }),
    })),
  );
}

export interface PromoDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  priceTotal: number;
  priceRegular: number;
  ageMin: number | null;
  ageMax: number | null;
  serviceIds: number[];
  startsAt: string;
  endsAt: string;
  bonusAmount: number;
  isActive: boolean;
  agentEnabled: boolean;
  open: boolean;
  services: { yclientsServiceId: number; title: string; price: number }[];
  /** Номера услуг акции, которых нет в нашем справочнике: видно, что засчитывать нечего. */
  unknownServiceIds: number[];
  schools: {
    id: string;
    name: string;
    isActive: boolean;
    contactName: string | null;
    totals: SchoolTotals;
  }[];
  totals: SchoolTotals;
  /** Что агент знает об акции — записи справочника, привязанные к ней. */
  knowledge: {
    id: string;
    topic: string;
    question: string;
    answer: string;
    isActive: boolean;
    needsDoctorApproval: boolean;
    approvedAt: string | null;
  }[];
}

export async function getPromo(
  companyId: string,
  id: string,
  now = new Date(),
): Promise<PromoDetail | null> {
  const p = await prisma.promo.findFirst({ where: { companyId, id } });
  if (!p) return null;
  const [services, schools, totals] = await Promise.all([
    prisma.service.findMany({
      where: { companyId, yclientsServiceId: { in: p.serviceIds } },
      select: { yclientsServiceId: true, title: true, price: true },
    }),
    prisma.partnerSchool.findMany({
      where: { companyId, promoId: p.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, isActive: true, contactName: true },
    }),
    totalsFor({ companyId, promoId: p.id }),
  ]);
  const knowledge = await prisma.knowledgeEntry.findMany({
    where: { companyId, promoId: p.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, topic: true, question: true, answer: true, isActive: true, needsDoctorApproval: true, approvedAt: true },
  });
  const known = new Set(services.map((s) => s.yclientsServiceId));
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    priceTotal: num(p.priceTotal),
    priceRegular: num(p.priceRegular),
    ageMin: p.ageMin,
    ageMax: p.ageMax,
    serviceIds: p.serviceIds,
    startsAt: p.startsAt.toISOString(),
    endsAt: p.endsAt.toISOString(),
    bonusAmount: num(p.bonusAmount),
    isActive: p.isActive,
    agentEnabled: p.agentEnabled,
    open: canAttribute(p, now),
    services: services.map((s) => ({
      yclientsServiceId: s.yclientsServiceId!,
      title: s.title,
      price: num(s.price),
    })),
    unknownServiceIds: p.serviceIds.filter((n) => !known.has(n)),
    schools: await Promise.all(
      schools.map(async (s) => ({
        ...s,
        totals: await totalsFor({ companyId, schoolId: s.id }),
      })),
    ),
    totals,
    knowledge: knowledge.map((k) => ({ ...k, approvedAt: k.approvedAt?.toISOString() ?? null })),
  };
}

/** Услуги, которые можно включить в акцию: есть номер YCLIENTS — иначе визит не сопоставить. */
export async function promoServiceChoices(companyId: string) {
  const rows = await prisma.service.findMany({
    where: { companyId, isActive: true, yclientsServiceId: { not: null } },
    orderBy: { title: "asc" },
    select: { yclientsServiceId: true, title: true, price: true },
  });
  return rows.map((s) => ({
    yclientsServiceId: s.yclientsServiceId!,
    title: s.title,
    price: num(s.price),
  }));
}

export interface SchoolPatientRow {
  attributionId: string;
  patientId: string;
  patientName: string;
  childNo: number;
  isExtraChild: boolean;
  note: string | null;
  source: "ADMIN" | "AGENT";
  attributedAt: string;
  createdBy: string | null;
  removedAt: string | null;
  bonus: {
    status: "EARNED" | "REVERSED";
    amount: number;
    earnedAt: string;
    reverseReason: string | null;
  } | null;
}

export interface SchoolDetail {
  id: string;
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  isActive: boolean;
  reportToken: string;
  promo: { id: string; name: string; endsAt: string };
  totals: SchoolTotals;
  patients: SchoolPatientRow[];
}

export async function getSchool(
  companyId: string,
  id: string,
): Promise<SchoolDetail | null> {
  const s = await prisma.partnerSchool.findFirst({
    where: { companyId, id },
    include: { promo: { select: { id: true, name: true, endsAt: true } } },
  });
  if (!s) return null;
  const rows = await prisma.partnerAttribution.findMany({
    where: { companyId, schoolId: s.id },
    orderBy: { attributedAt: "desc" },
    select: {
      id: true,
      patientId: true,
      childNo: true,
      isExtraChild: true,
      note: true,
      source: true,
      attributedAt: true,
      createdById: true,
      removedAt: true,
      patient: { select: { name: true } },
      bonus: {
        select: {
          status: true,
          amount: true,
          earnedAt: true,
          reverseReason: true,
        },
      },
    },
  });
  const staffIds = [
    ...new Set(
      rows.map((r) => r.createdById).filter((x): x is string => Boolean(x)),
    ),
  ];
  const staff = staffIds.length
    ? await prisma.staffUser.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, name: true },
      })
    : [];
  const staffName = new Map(staff.map((u) => [u.id, u.name]));
  return {
    id: s.id,
    name: s.name,
    contactName: s.contactName,
    contactPhone: s.contactPhone,
    isActive: s.isActive,
    reportToken: s.reportToken,
    promo: {
      id: s.promo.id,
      name: s.promo.name,
      endsAt: s.promo.endsAt.toISOString(),
    },
    totals: schoolTotals(
      rows.map((r) => ({
        removed: r.removedAt != null,
        bonus: r.bonus
          ? { status: r.bonus.status, amount: num(r.bonus.amount) }
          : null,
      })),
    ),
    patients: rows.map((r) => ({
      attributionId: r.id,
      patientId: r.patientId,
      patientName: r.patient.name ?? "без имени",
      childNo: r.childNo,
      isExtraChild: r.isExtraChild,
      note: r.note,
      source: r.source,
      attributedAt: r.attributedAt.toISOString(),
      createdBy:
        r.source === "AGENT"
          ? "агент"
          : r.createdById
            ? (staffName.get(r.createdById) ?? null)
            : null,
      removedAt: r.removedAt?.toISOString() ?? null,
      bonus: r.bonus
        ? {
            status: r.bonus.status,
            amount: num(r.bonus.amount),
            earnedAt: r.bonus.earnedAt.toISOString(),
            reverseReason: r.bonus.reverseReason,
          }
        : null,
    })),
  };
}

// ─────────────────────────────────────────────── публичный отчёт школы

/**
 * Отчёт школы по секретной ссылке. ТОЛЬКО агрегаты: ни имён, ни телефонов, ни
 * услуг, ни дат визитов. Школа перешлёт ссылку в общий чат родителей, и всё,
 * что здесь есть, увидят посторонние люди (§7).
 */
export interface PartnerReport {
  school: string;
  promo: string;
  attributed: number;
  arrived: number;
  bonusEarned: number;
}

export async function getPartnerReport(
  token: string,
): Promise<PartnerReport | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const s = await prisma.partnerSchool.findUnique({
    where: { reportToken: token },
    select: {
      id: true,
      companyId: true,
      name: true,
      isActive: true,
      promo: { select: { name: true } },
    },
  });
  if (!s || !s.isActive) return null;
  const t = await totalsFor({ companyId: s.companyId, schoolId: s.id });
  return {
    school: s.name,
    promo: s.promo.name,
    attributed: t.attributed,
    arrived: t.arrived,
    bonusEarned: t.bonusEarned,
  };
}

// ─────────────────────────────────────────────── привязка в карточке

export interface PatientPromoState {
  promos: {
    id: string;
    name: string;
    open: boolean;
    endsAt: string;
    schools: { id: string; name: string }[];
    attributions: {
      id: string;
      schoolName: string;
      childNo: number;
      isExtraChild: boolean;
      note: string | null;
      source: "ADMIN" | "AGENT";
      attributedAt: string;
      createdBy: string | null;
      bonus: {
        status: "EARNED" | "REVERSED";
        amount: number;
        reverseReason: string | null;
      } | null;
    }[];
  }[];
}

/**
 * Акции для карточки пациента: где можно привязать и что уже привязано.
 * Закончившаяся акция видна, только если у пациента по ней есть привязка.
 */
export async function patientPromoState(
  companyId: string,
  patientId: string,
  now = new Date(),
): Promise<PatientPromoState> {
  const [promos, attributions] = await Promise.all([
    prisma.promo.findMany({
      where: { companyId },
      orderBy: { endsAt: "desc" },
      select: {
        id: true,
        name: true,
        isActive: true,
        endsAt: true,
        schools: {
          where: { isActive: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        },
      },
    }),
    prisma.partnerAttribution.findMany({
      where: { companyId, patientId, removedAt: null },
      orderBy: { childNo: "asc" },
      select: {
        id: true,
        promoId: true,
        childNo: true,
        isExtraChild: true,
        note: true,
        source: true,
        attributedAt: true,
        createdById: true,
        school: { select: { name: true } },
        bonus: { select: { status: true, amount: true, reverseReason: true } },
      },
    }),
  ]);
  const staffIds = [
    ...new Set(
      attributions
        .map((a) => a.createdById)
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  const staff = staffIds.length
    ? await prisma.staffUser.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, name: true },
      })
    : [];
  const staffName = new Map(staff.map((u) => [u.id, u.name]));
  return {
    promos: promos
      .map((p) => ({
        id: p.id,
        name: p.name,
        open: canAttribute(p, now),
        endsAt: p.endsAt.toISOString(),
        schools: p.schools,
        attributions: attributions
          .filter((a) => a.promoId === p.id)
          .map((a) => ({
            id: a.id,
            schoolName: a.school?.name ?? "без школы",
            childNo: a.childNo,
            isExtraChild: a.isExtraChild,
            note: a.note,
            source: a.source,
            attributedAt: a.attributedAt.toISOString(),
            createdBy:
              a.source === "AGENT"
                ? "агент"
                : a.createdById
                  ? (staffName.get(a.createdById) ?? null)
                  : null,
            bonus: a.bonus
              ? {
                  status: a.bonus.status,
                  amount: num(a.bonus.amount),
                  reverseReason: a.bonus.reverseReason,
                }
              : null,
          })),
      }))
      .filter((p) => p.open || p.attributions.length > 0),
  };
}

export type AttachResult =
  | { ok: true; attributionId: string }
  | { ok: false; reason: string }
  /** В семье уже есть привязка — второй ребёнок только по явному согласию. */
  | { ok: false; family: { who: string; school: string }[] };

/**
 * Семья пациента по акции: та же карточка (дети записаны на родителя),
 * карточки, связанные родством, и привязки из той же переписки.
 */
async function familyAttributions(
  companyId: string,
  promoId: string,
  patientId: string,
  conversationId: string | null,
) {
  const relations = await prisma.patientRelation.findMany({
    where: { companyId, OR: [{ patientId }, { relatedPatientId: patientId }] },
    select: { patientId: true, relatedPatientId: true },
  });
  const ids = new Set([
    patientId,
    ...relations.flatMap((r) => [r.patientId, r.relatedPatientId]),
  ]);
  return prisma.partnerAttribution.findMany({
    where: {
      companyId,
      promoId,
      removedAt: null,
      OR: [
        { patientId: { in: [...ids] } },
        ...(conversationId ? [{ conversationId }] : []),
      ],
    },
    select: {
      patientId: true,
      childNo: true,
      note: true,
      patient: { select: { name: true } },
      school: { select: { name: true } },
    },
  });
}

export async function attachToSchool(input: {
  companyId: string;
  actorId: string | null;
  patientId: string;
  /** Пусто — пришёл по акции сам, без школы: бонуса не будет. */
  schoolId: string | null;
  conversationId: string | null;
  childName: string | null;
  /** Администратор подтвердил: это второй ребёнок той же семьи. */
  extraChild: boolean;
  now?: Date;
}): Promise<AttachResult> {
  const now = input.now ?? new Date();
  const school = input.schoolId
    ? await prisma.partnerSchool.findFirst({
        where: { id: input.schoolId, companyId: input.companyId },
        select: { id: true, isActive: true, promoId: true },
      })
    : null;
  if (input.schoolId && (!school || !school.isActive)) return { ok: false, reason: "Школа не найдена или выключена." };
  const promoId = school?.promoId ?? (await ensureSchoolPromo(input.companyId));
  const promoRow = await prisma.promo.findUniqueOrThrow({
    where: { id: promoId },
    select: { id: true, isActive: true, endsAt: true, bonusAmount: true },
  });
  const promoOf = { promo: promoRow };
  if (!canAttribute(promoOf.promo, now)) {
    return {
      ok: false,
      reason:
        "Акция закончилась или выключена — новые привязки не заводятся. Прежние работают.",
    };
  }
  const patient = await prisma.patient.findFirst({
    where: { id: input.patientId, companyId: input.companyId, deletedAt: null },
    select: { id: true },
  });
  if (!patient) return { ok: false, reason: "Пациент не найден." };

  const family = await familyAttributions(
    input.companyId,
    promoRow.id,
    input.patientId,
    input.conversationId,
  );
  if (family.length > 0 && !input.extraChild) {
    return {
      ok: false,
      family: family.map((f) => ({
        who: f.note || f.patient.name || "без имени",
        school: f.school?.name ?? "без школы",
      })),
    };
  }
  const sameCard = family.filter((f) => f.patientId === input.patientId);
  const childNo = sameCard.length
    ? Math.max(...sameCard.map((f) => f.childNo)) + 1
    : 1;

  // Снятая раньше привязка с тем же номером ребёнка восстанавливается, а не
  // заводится второй строкой: удаления нет, ключ уникален.
  const previous = await prisma.partnerAttribution.findUnique({
    where: {
      patientId_promoId_childNo: {
        patientId: input.patientId,
        promoId: promoRow.id,
        childNo,
      },
    },
    select: { id: true },
  });
  const data = {
    schoolId: school?.id ?? null,
    source: "ADMIN" as const,
    conversationId: input.conversationId,
    bonusAmountFrozen: promoRow.bonusAmount,
    attributedAt: now,
    createdById: input.actorId,
    isExtraChild: family.length > 0,
    note: input.childName?.trim() || null,
    removedAt: null,
    removedById: null,
  };
  const row = previous
    ? await prisma.partnerAttribution.update({
        where: { id: previous.id },
        data,
        select: { id: true },
      })
    : await prisma.partnerAttribution.create({
        data: {
          ...data,
          companyId: input.companyId,
          promoId: promoRow.id,
          patientId: input.patientId,
          childNo,
        },
        select: { id: true },
      });
  await recomputePartnerBonuses(input.companyId, now);
  return { ok: true, attributionId: row.id };
}

/** Снять привязку. Строка остаётся, бонус по ней снимается с причиной. */
export async function detachFromSchool(input: {
  companyId: string;
  actorId: string | null;
  attributionId: string;
}): Promise<boolean> {
  const r = await prisma.partnerAttribution.updateMany({
    where: {
      id: input.attributionId,
      companyId: input.companyId,
      removedAt: null,
    },
    data: { removedAt: new Date(), removedById: input.actorId },
  });
  if (r.count) {
    // Убрали из акции — бонус снимается и тогда, когда его ставили руками.
    await prisma.partnerBonus.updateMany({
      where: { attributionId: input.attributionId, status: "EARNED" },
      data: { status: "REVERSED", reversedAt: new Date(), reverseReason: "убран из акции", manual: true, setById: input.actorId },
    });
    await recomputePartnerBonuses(input.companyId);
  }
  return r.count > 0;
}

// ─────────────────────────────────────────────── агент

/**
 * Акции, которые МОГУТ быть видны агенту сейчас, со школами и записями
 * справочника. Решение «видна ли в этом разговоре» — `visiblePromos` в
 * lib/agent/promo.ts; здесь только факты. Записи — по тем же правилам, что
 * общий справочник: включена и, если медицинская, утверждена врачом.
 */
export async function promosForAgent(companyId: string, now = new Date()) {
  const rows = await prisma.promo.findMany({
    where: { companyId, isActive: true, agentEnabled: true, startsAt: { lte: now }, endsAt: { gte: now } },
    select: {
      id: true,
      isActive: true,
      agentEnabled: true,
      startsAt: true,
      endsAt: true,
      ageMin: true,
      ageMax: true,
      bonusAmount: true,
      schools: { where: { isActive: true }, select: { id: true, name: true } },
      knowledge: {
        where: { isActive: true, OR: [{ needsDoctorApproval: false }, { approvedAt: { not: null } }] },
        orderBy: { createdAt: "asc" },
        select: { id: true, topic: true, question: true, answer: true },
      },
    },
  });
  return rows.map((r) => ({ ...r, entries: r.knowledge }));
}

/** Есть ли у семьи пациента привязка по акции: тогда про школу не спрашиваем. */
export async function familyAttributed(
  companyId: string,
  promoId: string,
  patientId: string | null,
  conversationId: string,
): Promise<boolean> {
  if (patientId) return (await familyAttributions(companyId, promoId, patientId, conversationId)).length > 0;
  return (await prisma.partnerAttribution.count({ where: { companyId, promoId, conversationId, removedAt: null } })) > 0;
}

/**
 * Привязка, которую ставит агент по словам пациента. Только ПЕРВЫЙ ребёнок
 * семьи: второго добавляет администратор, агент — никогда. Есть привязка в
 * семье — ничего не делаем.
 */
export async function attachByAgent(input: {
  companyId: string;
  patientId: string;
  conversationId: string;
  schoolId: string;
  now?: Date;
}): Promise<"attached" | "exists" | "closed"> {
  const now = input.now ?? new Date();
  const school = await prisma.partnerSchool.findFirst({
    where: { id: input.schoolId, companyId: input.companyId, isActive: true },
    select: { id: true, promo: { select: { id: true, isActive: true, endsAt: true, bonusAmount: true } } },
  });
  if (!school || !canAttribute(school.promo, now)) return "closed";
  if ((await familyAttributions(input.companyId, school.promo.id, input.patientId, input.conversationId)).length > 0) {
    return "exists";
  }
  const previous = await prisma.partnerAttribution.findUnique({
    where: { patientId_promoId_childNo: { patientId: input.patientId, promoId: school.promo.id, childNo: 1 } },
    select: { id: true },
  });
  const data = {
    schoolId: school.id,
    source: "AGENT" as const,
    conversationId: input.conversationId,
    bonusAmountFrozen: school.promo.bonusAmount,
    attributedAt: now,
    createdById: null,
    isExtraChild: false,
    note: null,
    removedAt: null,
    removedById: null,
  };
  if (previous) await prisma.partnerAttribution.update({ where: { id: previous.id }, data });
  else
    await prisma.partnerAttribution.create({
      data: { ...data, companyId: input.companyId, promoId: school.promo.id, patientId: input.patientId, childNo: 1 },
    });
  await recomputePartnerBonuses(input.companyId, now);
  return "attached";
}

// ─────────────────────────────────────────────── одна акция: «Школьный check-up»

/**
 * Акция у клиники одна (решение заказчика, 15 октября), и экран построен под
 * неё, а не под список акций. Заводится сама при первом открытии — с составом
 * и ценами с макета. Позиции связываются со строками YCLIENTS, где строка
 * однозначно находится по виду и цене; остальные администратор связывает сам —
 * или отмечает «прошёл» руками.
 */
export interface PromoItem {
  title: string;
  price: number;
  yclientsServiceId: number | null;
}

export const SCHOOL_PROMO = {
  slug: "school-checkup",
  name: "Школьный check-up",
  description: "Школьникам 6–14 лет, один визит. Есть противопоказания, необходима консультация специалиста.",
  priceTotal: 6300,
  priceRegular: 9360,
  ageMin: 6,
  ageMax: 14,
  endsOn: "2026-11-15",
  bonusAmount: 500,
  items: [
    { title: "Приём детского остеопата", price: 4000, match: /остео/i, also: /дет/i },
    { title: "Диагностика у БОС-специалиста", price: 1000, match: /бос/i, also: /диагност/i },
    { title: "Лабораторные анализы (ОАК, ферритин, витамин D, общий анализ мочи)", price: 2860, match: /анализ|лаборат/i, also: null },
    { title: "Экспертная расшифровка и рекомендации", price: 1500, match: /расшифр|рекоменд/i, also: null },
  ],
} as const;

/** Позиция → строка прайса: та же цена и слова вида; ровно одна — иначе не связываем. */
export function linkItems(
  services: { yclientsServiceId: number | null; title: string; price: number }[],
): PromoItem[] {
  return SCHOOL_PROMO.items.map((it) => {
    const hits = services.filter(
      (s) =>
        s.yclientsServiceId != null &&
        s.price === it.price &&
        it.match.test(s.title) &&
        (!it.also || it.also.test(s.title)),
    );
    return { title: it.title, price: it.price, yclientsServiceId: hits.length === 1 ? hits[0].yclientsServiceId : null };
  });
}

function itemsOf(raw: unknown): PromoItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"))
    .map((x) => ({
      title: String(x.title ?? ""),
      price: Number(x.price ?? 0),
      yclientsServiceId: typeof x.yclientsServiceId === "number" ? x.yclientsServiceId : null,
    }))
    .filter((x) => x.title);
}

/** Идентификатор единственной акции клиники; нет — заводится с составом с макета. */
export async function ensureSchoolPromo(companyId: string): Promise<string> {
  const existing = await prisma.promo.findFirst({ where: { companyId }, orderBy: { createdAt: "asc" }, select: { id: true, items: true, serviceIds: true } });
  const services = (
    await prisma.service.findMany({ where: { companyId }, select: { yclientsServiceId: true, title: true, price: true } })
  ).map((s) => ({ ...s, price: num(s.price) }));
  if (existing) {
    // Акцию завели до того, как у неё появился состав, — дописываем его, ничего не теряя.
    if (itemsOf(existing.items).length === 0) {
      const items = linkItems(services);
      const ids = [...new Set([...existing.serviceIds, ...items.flatMap((i) => (i.yclientsServiceId ? [i.yclientsServiceId] : []))])];
      await prisma.promo.update({ where: { id: existing.id }, data: { items: items as unknown as object[], serviceIds: ids } });
    }
    return existing.id;
  }
  const items = linkItems(services);
  const endsAt = new Date(clinicDayRange(new Date(`${SCHOOL_PROMO.endsOn}T12:00:00Z`)).end.getTime() - 1);
  const created = await prisma.promo.create({
    data: {
      companyId,
      slug: SCHOOL_PROMO.slug,
      name: SCHOOL_PROMO.name,
      description: SCHOOL_PROMO.description,
      priceTotal: SCHOOL_PROMO.priceTotal,
      priceRegular: SCHOOL_PROMO.priceRegular,
      ageMin: SCHOOL_PROMO.ageMin,
      ageMax: SCHOOL_PROMO.ageMax,
      startsAt: startOfClinicDay(),
      endsAt,
      bonusAmount: SCHOOL_PROMO.bonusAmount,
      items: items as unknown as object[],
      serviceIds: items.flatMap((i) => (i.yclientsServiceId ? [i.yclientsServiceId] : [])),
    },
    select: { id: true },
  });
  return created.id;
}

export type ParticipantStatus = "waiting" | "done" | "bonus" | "reversed" | "no_school";

export interface PromoParticipant {
  attributionId: string;
  patientId: string;
  patientName: string;
  phoneTail: string | null;
  schoolId: string | null;
  schoolName: string | null;
  childNo: number;
  note: string | null;
  source: "ADMIN" | "AGENT";
  attributedAt: string;
  createdBy: string | null;
  completedAt: string | null;
  status: ParticipantStatus;
  bonus: { status: "EARNED" | "REVERSED"; amount: number; manual: boolean; reason: string | null; at: string } | null;
}

export interface SchoolPromoView {
  id: string;
  name: string;
  description: string | null;
  priceTotal: number;
  priceRegular: number;
  ageMin: number | null;
  ageMax: number | null;
  startsOn: string;
  endsOn: string;
  bonusAmount: number;
  isActive: boolean;
  agentEnabled: boolean;
  open: boolean;
  items: (PromoItem & { serviceTitle: string | null })[];
  services: { yclientsServiceId: number; title: string; price: number }[];
  schools: { id: string; name: string; contactName: string | null; contactPhone: string | null; isActive: boolean; reportToken: string; totals: SchoolTotals }[];
  participants: PromoParticipant[];
  totals: SchoolTotals;
  knowledge: PromoDetail["knowledge"];
}

function statusOf(a: { schoolId: string | null; completedAt: Date | null; bonus: { status: string } | null }): ParticipantStatus {
  if (a.bonus?.status === "EARNED") return "bonus";
  if (a.bonus?.status === "REVERSED") return "reversed";
  if (a.completedAt) return "done";
  if (!a.schoolId) return "no_school";
  return "waiting";
}

export async function getSchoolPromoView(companyId: string, now = new Date()): Promise<SchoolPromoView> {
  const id = await ensureSchoolPromo(companyId);
  const [p, services, schools, rows, knowledge] = await Promise.all([
    prisma.promo.findUniqueOrThrow({ where: { id } }),
    prisma.service.findMany({
      where: { companyId, yclientsServiceId: { not: null } },
      orderBy: { title: "asc" },
      select: { yclientsServiceId: true, title: true, price: true, isActive: true },
    }),
    prisma.partnerSchool.findMany({ where: { companyId, promoId: id }, orderBy: { createdAt: "asc" } }),
    prisma.partnerAttribution.findMany({
      where: { companyId, promoId: id, removedAt: null },
      orderBy: { attributedAt: "desc" },
      select: {
        id: true,
        patientId: true,
        schoolId: true,
        childNo: true,
        note: true,
        source: true,
        attributedAt: true,
        createdById: true,
        completedAt: true,
        patient: { select: { name: true, phones: { take: 1, orderBy: { isPrimary: "desc" }, select: { phone: true } } } },
        school: { select: { name: true } },
        bonus: { select: { status: true, amount: true, manual: true, reverseReason: true, earnedAt: true, reversedAt: true } },
      },
    }),
    prisma.knowledgeEntry.findMany({
      where: { companyId, promoId: id },
      orderBy: { createdAt: "asc" },
      select: { id: true, topic: true, question: true, answer: true, isActive: true, needsDoctorApproval: true, approvedAt: true },
    }),
  ]);
  const staffIds = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => Boolean(x)))];
  const staff = staffIds.length ? await prisma.staffUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }) : [];
  const staffName = new Map(staff.map((u) => [u.id, u.name]));
  const all = await prisma.partnerAttribution.findMany({
    where: { companyId, promoId: id },
    select: { schoolId: true, removedAt: true, bonus: { select: { status: true, amount: true } } },
  });
  const totalsOf = (filter: (r: (typeof all)[number]) => boolean) =>
    schoolTotals(all.filter(filter).map((r) => ({ removed: r.removedAt != null, bonus: r.bonus ? { status: r.bonus.status, amount: num(r.bonus.amount) } : null })));
  const items = itemsOf(p.items);
  const byYc = new Map(services.map((s) => [s.yclientsServiceId!, s.title]));
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    priceTotal: num(p.priceTotal),
    priceRegular: num(p.priceRegular),
    ageMin: p.ageMin,
    ageMax: p.ageMax,
    startsOn: clinicDateKey(p.startsAt),
    endsOn: clinicDateKey(p.endsAt),
    bonusAmount: num(p.bonusAmount),
    isActive: p.isActive,
    agentEnabled: p.agentEnabled,
    open: canAttribute(p, now),
    items: items.map((i) => ({ ...i, serviceTitle: i.yclientsServiceId ? (byYc.get(i.yclientsServiceId) ?? null) : null })),
    services: services
      .filter((s) => s.isActive)
      .map((s) => ({ yclientsServiceId: s.yclientsServiceId!, title: s.title, price: num(s.price) })),
    schools: schools.map((s) => ({
      id: s.id,
      name: s.name,
      contactName: s.contactName,
      contactPhone: s.contactPhone,
      isActive: s.isActive,
      reportToken: s.reportToken,
      totals: totalsOf((r) => r.schoolId === s.id),
    })),
    participants: rows.map((r) => ({
      attributionId: r.id,
      patientId: r.patientId,
      patientName: r.patient.name ?? "без имени",
      phoneTail: r.patient.phones[0]?.phone.slice(-4) ?? null,
      schoolId: r.schoolId,
      schoolName: r.school?.name ?? null,
      childNo: r.childNo,
      note: r.note,
      source: r.source,
      attributedAt: r.attributedAt.toISOString(),
      createdBy: r.source === "AGENT" ? "агент" : r.createdById ? (staffName.get(r.createdById) ?? null) : null,
      completedAt: r.completedAt?.toISOString() ?? null,
      status: statusOf(r),
      bonus: r.bonus
        ? {
            status: r.bonus.status,
            amount: num(r.bonus.amount),
            manual: r.bonus.manual,
            reason: r.bonus.reverseReason,
            at: (r.bonus.status === "REVERSED" && r.bonus.reversedAt ? r.bonus.reversedAt : r.bonus.earnedAt).toISOString(),
          }
        : null,
    })),
    totals: totalsOf(() => true),
    knowledge: knowledge.map((k) => ({ ...k, approvedAt: k.approvedAt?.toISOString() ?? null })),
  };
}

/** Найти пациента для добавления в акцию: по началу слов имени или по цифрам телефона. */
export async function searchPatientsForPromo(companyId: string, q: string): Promise<{ id: string; name: string; phoneTail: string | null }[]> {
  const digits = q.replace(/\D/g, "");
  const words = q
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 2);
  if (digits.length < 4 && words.length === 0) return [];
  const rows = await prisma.patient.findMany({
    where: {
      companyId,
      deletedAt: null,
      ...(digits.length >= 4
        ? { phones: { some: { phone: { contains: digits.slice(-10) } } } }
        : { AND: words.map((w) => ({ name: { contains: w, mode: "insensitive" as const } })) }),
    },
    take: 100,
    orderBy: { lastVisitAt: { sort: "desc", nulls: "last" } },
    select: { id: true, name: true, phones: { take: 1, orderBy: { isPrimary: "desc" }, select: { phone: true } } },
  });
  const norm = (t: string) => t.toLowerCase().replace(/ё/g, "е");
  return rows
    .filter((r) => digits.length >= 4 || words.every((w) => norm(r.name ?? "").split(/[^\p{L}]+/u).some((x) => x.startsWith(w))))
    .slice(0, 10)
    .map((r) => ({ id: r.id, name: r.name ?? "без имени", phoneTail: r.phones[0]?.phone.slice(-4) ?? null }));
}

/**
 * «Прошёл всё» — руками. Есть школа — бонус ставится сразу и помечается ручным:
 * пересчёт его не снимет и не продублирует. Сам визит в YCLIENTS при этом не
 * нужен — администратор знает лучше (позиции может не быть в прайсе).
 */
export async function markParticipantDone(companyId: string, actorId: string | null, attributionId: string, now = new Date()): Promise<void> {
  const a = await prisma.partnerAttribution.findFirst({
    where: { id: attributionId, companyId, removedAt: null },
    select: { id: true, schoolId: true, bonusAmountFrozen: true, bonus: { select: { id: true } } },
  });
  if (!a) throw new Error("Участник не найден или уже убран из акции.");
  await prisma.partnerAttribution.update({ where: { id: a.id }, data: { completedAt: now, completedById: actorId } });
  if (!a.schoolId) return;
  const data = {
    status: "EARNED" as const,
    amount: a.bonusAmountFrozen,
    earnedAt: now,
    manual: true,
    setById: actorId,
    reversedAt: null,
    reverseReason: null,
    schoolId: a.schoolId,
  };
  if (a.bonus) await prisma.partnerBonus.update({ where: { id: a.bonus.id }, data });
  else await prisma.partnerBonus.create({ data: { ...data, companyId, attributionId: a.id, triggeredByAppointmentId: null } });
}

/** Снять отметку «прошёл» — и ручной бонус вместе с ней. */
export async function unmarkParticipantDone(companyId: string, actorId: string | null, attributionId: string): Promise<void> {
  const r = await prisma.partnerAttribution.updateMany({ where: { id: attributionId, companyId }, data: { completedAt: null, completedById: null } });
  if (!r.count) throw new Error("Участник не найден.");
  await prisma.partnerBonus.updateMany({
    where: { attributionId, status: "EARNED", manual: true },
    data: { status: "REVERSED", reversedAt: new Date(), reverseReason: "отметку «прошёл» сняли вручную", setById: actorId },
  });
}

/** Снять бонус руками — с причиной; пересчёт его обратно не вернёт. */
export async function revokeParticipantBonus(companyId: string, actorId: string | null, attributionId: string, reason: string | null): Promise<void> {
  const r = await prisma.partnerBonus.updateMany({
    where: { attributionId, companyId, status: "EARNED" },
    data: { status: "REVERSED", reversedAt: new Date(), reverseReason: reason?.trim() || "снят вручную", manual: true, setById: actorId },
  });
  if (!r.count) throw new Error("Начисленного бонуса нет.");
}

/** Сменить школу участника (или убрать её). Бонус переходит за школой; без школы — снимается. */
export async function setParticipantSchool(companyId: string, actorId: string | null, attributionId: string, schoolId: string | null): Promise<void> {
  if (schoolId) {
    const ok = await prisma.partnerSchool.findFirst({ where: { id: schoolId, companyId }, select: { id: true } });
    if (!ok) throw new Error("Школа не найдена.");
  }
  const r = await prisma.partnerAttribution.updateMany({ where: { id: attributionId, companyId, removedAt: null }, data: { schoolId } });
  if (!r.count) throw new Error("Участник не найден.");
  if (schoolId) await prisma.partnerBonus.updateMany({ where: { attributionId }, data: { schoolId } });
  else
    await prisma.partnerBonus.updateMany({
      where: { attributionId, status: "EARNED" },
      data: { status: "REVERSED", reversedAt: new Date(), reverseReason: "школу убрали", manual: true, setById: actorId },
    });
  await recomputePartnerBonuses(companyId);
}
