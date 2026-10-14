import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
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
        bonusAmountFrozen: true,
        bonus: {
          select: {
            id: true,
            status: true,
            triggeredByAppointmentId: true,
            reversedAt: true,
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
        bonus: a.bonus
          ? {
              id: a.bonus.id,
              status: a.bonus.status,
              triggeredByAppointmentId: a.bonus.triggeredByAppointmentId,
              reversedAt: a.bonus.reversedAt,
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
            schoolName: a.school.name,
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
  schoolId: string;
  conversationId: string | null;
  childName: string | null;
  /** Администратор подтвердил: это второй ребёнок той же семьи. */
  extraChild: boolean;
  now?: Date;
}): Promise<AttachResult> {
  const now = input.now ?? new Date();
  const school = await prisma.partnerSchool.findFirst({
    where: { id: input.schoolId, companyId: input.companyId },
    select: {
      id: true,
      isActive: true,
      promo: {
        select: { id: true, isActive: true, endsAt: true, bonusAmount: true },
      },
    },
  });
  if (!school || !school.isActive)
    return { ok: false, reason: "Школа не найдена или выключена." };
  if (!canAttribute(school.promo, now)) {
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
    school.promo.id,
    input.patientId,
    input.conversationId,
  );
  if (family.length > 0 && !input.extraChild) {
    return {
      ok: false,
      family: family.map((f) => ({
        who: f.note || f.patient.name || "без имени",
        school: f.school.name,
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
        promoId: school.promo.id,
        childNo,
      },
    },
    select: { id: true },
  });
  const data = {
    schoolId: school.id,
    source: "ADMIN" as const,
    conversationId: input.conversationId,
    bonusAmountFrozen: school.promo.bonusAmount,
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
          promoId: school.promo.id,
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
  if (r.count) await recomputePartnerBonuses(input.companyId);
  return r.count > 0;
}
