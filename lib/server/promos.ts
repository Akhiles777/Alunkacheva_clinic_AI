import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { CLINIC_TZ, clinicDateKey, clinicDayRange, startOfClinicDay } from "@/lib/clinic-time";
import {
  bonusActions,
  canAttribute,
  graceEnd,
  schoolTotals,
  visitKeyOf,
  promoVisits,
  type AttributionFact,
  type BonusAction,
  type SchoolTotals,
  type VisitFact,
} from "@/lib/metrics/partner-bonus";
import { promoServiceSet, snapshotFrom, type CatalogService, type PromoServiceWarning } from "@/lib/metrics/promo-services";
import { DEFAULT_MARKER, LEGACY_MARKER, effectiveMarker, hasMarker, inFirstDay, markerProbe, waLink } from "@/lib/metrics/promo-marker";
import { noticeAboutPromo, noticeMismatch, parseNotice, type ParsedNotice } from "@/lib/metrics/yclients-notice";
import { clinicMoment } from "@/lib/agent/status-slot";

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

/** Справочник услуг клиники для состава акции. */
async function serviceCatalog(companyId: string): Promise<CatalogService[]> {
  return prisma.service.findMany({
    where: { companyId, yclientsServiceId: { not: null } },
    select: { yclientsServiceId: true, title: true, isActive: true },
  });
}

/** Услуги акции: выбранные плюс пойманные по названию (`promoServiceSet`). */
function serviceSetOf(
  promo: { serviceIds: number[]; serviceKeywords: string[]; excludedServiceIds: number[]; serviceSnapshot: unknown },
  catalog: CatalogService[],
) {
  return promoServiceSet(
    {
      serviceIds: promo.serviceIds,
      serviceKeywords: promo.serviceKeywords,
      excludedServiceIds: promo.excludedServiceIds,
      serviceSnapshot: snapshotFrom(promo.serviceSnapshot),
    },
    catalog,
  );
}

/**
 * Пациенты, которых клиника знала до начала акции: карточка появилась раньше
 * или есть запись раньше. Их привязка остаётся (видно, откуда пришли), но
 * бонуса школе не приносит — школа привела не их.
 */
async function returningPatients(companyId: string, patientIds: string[], startsAt: Date): Promise<Set<string>> {
  if (patientIds.length === 0) return new Set();
  const [early, visits] = await Promise.all([
    prisma.patient.findMany({ where: { companyId, id: { in: patientIds }, firstSeenAt: { lt: startsAt } }, select: { id: true } }),
    prisma.appointment.findMany({
      where: { companyId, patientId: { in: patientIds }, deletedAt: null, startAt: { lt: startsAt } },
      select: { patientId: true },
      distinct: ["patientId"],
    }),
  ]);
  return new Set([...early.map((p) => p.id), ...visits.map((v) => v.patientId)]);
}

/**
 * Привязка по метке: сообщение ПАЦИЕНТА с меткой школы в первые сутки
 * обращения, пока акция идёт. Идёт тем же кругом, что пересчёт бонусов, а не
 * в вебхуке: у нового пациента карточки в момент сообщения часто ещё нет —
 * она появится, когда администратор запишет его в YCLIENTS, и привязка
 * поставится на ближайшем круге.
 *
 * Привязка уже есть — не трогаем (решение человека важнее метки), кроме одной:
 * «на проверке» по улике модели метка подтверждает сама.
 */
async function attachByMarkers(
  companyId: string,
  promo: { id: string; isActive: boolean; startsAt: Date; endsAt: Date; waMarker: string; bonusAmount: { toString(): string } },
  schoolId: string | null,
): Promise<number> {
  const marker = effectiveMarker(promo.waMarker);
  if (!promo.isActive) return 0;
  const hits = await prisma.message.findMany({
    where: {
      companyId,
      direction: "IN",
      authorType: "PATIENT",
      deletedAt: null,
      createdAt: { gte: promo.startsAt, lte: promo.endsAt },
      // Грубый отбор в базе — по основе метки; точная проверка — `hasMarker`.
      body: { contains: markerProbe(marker), mode: "insensitive" },
      conversation: { isPractice: false, patientId: { not: null } },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, body: true, createdAt: true, conversationId: true, conversation: { select: { patientId: true } } },
  });
  let attached = 0;
  const seen = new Set<string>();
  for (const hit of hits) {
    const patientId = hit.conversation.patientId!;
    if (seen.has(patientId) || !hasMarker(hit.body, marker)) continue;
    const before = await prisma.message.findMany({
      where: { conversationId: hit.conversationId, direction: "IN", deletedAt: null, createdAt: { lt: hit.createdAt, gte: new Date(hit.createdAt.getTime() - 14 * 86_400_000) } },
      select: { createdAt: true },
    });
    if (!inFirstDay(hit.createdAt, before.map((m) => m.createdAt))) continue;
    seen.add(patientId);

    const existing = await prisma.partnerAttribution.findMany({
      where: { companyId, promoId: promo.id, patientId },
      select: { id: true, confidence: true, reviewStatus: true },
    });
    const review = existing.find((a) => a.confidence === "AI_EVIDENCE" && a.reviewStatus === "REVIEW");
    if (review) {
      await prisma.partnerAttribution.update({
        where: { id: review.id },
        data: { confidence: "MARKER", reviewStatus: "CONFIRMED", evidenceMessageId: hit.id, evidenceQuote: marker, attributedAt: hit.createdAt },
      });
      attached += 1;
      continue;
    }
    if (existing.length > 0) continue;
    const returning = (await returningPatients(companyId, [patientId], promo.startsAt)).has(patientId);
    const created = await prisma.partnerAttribution
      .create({
        data: {
          companyId,
          promoId: promo.id,
          patientId,
          schoolId,
          conversationId: hit.conversationId,
          source: "AGENT",
          confidence: "MARKER",
          reviewStatus: "CONFIRMED",
          evidenceMessageId: hit.id,
          evidenceQuote: marker,
          bonusAmountFrozen: promo.bonusAmount.toString(),
          attributedAt: hit.createdAt,
          childNo: 1,
          returningPatient: returning,
        },
        select: { id: true },
      })
      .then(() => true)
      // Параллельный круг успел первым — уникальность держит база.
      .catch(() => false);
    if (created) attached += 1;
  }
  return attached;
}

/**
 * Пересчитать бонусы по всем акциям клиники. Идемпотентно: идёт после каждой
 * выгрузки YCLIENTS, и повтор на тех же фактах ничего не меняет. Сначала
 * ставятся привязки по метке, потом считаются бонусы.
 */
export async function recomputePartnerBonuses(
  companyId: string,
  now = new Date(),
  options: { dryRun?: boolean; plan?: BonusAction[] } = {},
): Promise<{ earned: number; reversed: number; retargeted: number; attached: number }> {
  const promos = await prisma.promo.findMany({
    where: { companyId },
    select: {
      id: true,
      isActive: true,
      serviceIds: true,
      serviceKeywords: true,
      excludedServiceIds: true,
      serviceSnapshot: true,
      startsAt: true,
      endsAt: true,
      waMarker: true,
      bonusAmount: true,
      schools: { where: { isActive: true }, orderBy: { createdAt: "asc" }, take: 1, select: { id: true } },
    },
  });
  const catalog = promos.length ? await serviceCatalog(companyId) : [];
  let earned = 0;
  let reversed = 0;
  let retargeted = 0;
  let attached = 0;
  for (const promo of promos) {
    if (!options.dryRun) attached += await attachByMarkers(companyId, promo, promo.schools[0]?.id ?? null);
    const rule = { serviceIds: serviceSetOf(promo, catalog).ids, startsAt: promo.startsAt, endsAt: promo.endsAt };
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
        reviewStatus: true,
        returningPatient: true,
        bonusAmountFrozen: true,
        bonus: {
          select: { id: true, status: true, triggeredByAppointmentId: true, triggeredByVisitKey: true, reversedAt: true, manual: true },
        },
      },
    });
    if (!attributions.length) continue;
    const patientIds = [...new Set(attributions.map((a) => a.patientId))];

    // «Повторный пациент» — факт, а не настройка: держим отметку в согласии с данными.
    const returning = await returningPatients(companyId, patientIds, promo.startsAt);
    const flip = attributions.filter((a) => a.returningPatient !== returning.has(a.patientId));
    if (flip.length && !options.dryRun) {
      for (const a of flip) {
        await prisma.partnerAttribution.update({ where: { id: a.id }, data: { returningPatient: returning.has(a.patientId) } });
      }
    }

    const recordSelect = {
      id: true,
      yclientsVisitId: true,
      patientId: true,
      startAt: true,
      status: true,
      deletedAt: true,
      services: { select: { quantity: true, service: { select: { yclientsServiceId: true } } } },
    } as const;
    const records = await prisma.appointment.findMany({
      where: { companyId, patientId: { in: patientIds }, startAt: { gte: promo.startsAt, lte: graceEnd(promo) } },
      select: recordSelect,
    });
    // Основание начисленного бонуса могло уехать за окно — его тоже нужно видеть.
    const missing = attributions
      .map((a) => a.bonus?.triggeredByAppointmentId)
      .filter((x): x is string => Boolean(x) && !records.some((r) => r.id === x));
    if (missing.length) records.push(...(await prisma.appointment.findMany({ where: { companyId, id: { in: missing } }, select: recordSelect })));

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
        confirmed: a.reviewStatus === "CONFIRMED",
        returning: returning.has(a.patientId),
        bonus: a.bonus
          ? {
              id: a.bonus.id,
              status: a.bonus.status,
              triggeredByAppointmentId: a.bonus.triggeredByAppointmentId,
              triggeredByVisitKey: a.bonus.triggeredByVisitKey,
              reversedAt: a.bonus.reversedAt,
              manual: a.bonus.manual,
            }
          : null,
      }));
      const visitFacts: VisitFact[] = records
        .filter((v) => v.patientId === patientId)
        .map((v) => ({
          id: v.id,
          startAt: v.startAt,
          status: v.status,
          deleted: v.deletedAt != null,
          visitKey: visitKeyOf(v),
          services: v.services.map((s) => ({ yclientsServiceId: s.service.yclientsServiceId, quantity: s.quantity })),
        }));
      for (const act of bonusActions(rule, facts, visitFacts)) {
        options.plan?.push(act);
        // Сухой прогон: только считаем, что изменилось бы.
        if (options.dryRun) {
          if (act.kind === "earn") earned += 1;
          else if (act.kind === "retarget") retargeted += 1;
          else reversed += 1;
          continue;
        }
        if (act.kind === "earn" && act.bonusId) {
          const r = await prisma.partnerBonus.updateMany({
            where: { id: act.bonusId, status: "REVERSED", manual: false },
            data: {
              status: "EARNED",
              triggeredByAppointmentId: act.appointmentId,
              triggeredByVisitKey: act.visitKey,
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
                triggeredByVisitKey: act.visitKey,
                earnedAt: act.earnedAt,
              },
            })
            .then(() => true)
            .catch(() => false);
          if (created) earned += 1;
        } else if (act.kind === "retarget") {
          const r = await prisma.partnerBonus.updateMany({
            where: { id: act.bonusId, status: "EARNED", manual: false },
            data: { triggeredByAppointmentId: act.appointmentId, triggeredByVisitKey: act.visitKey },
          });
          retargeted += r.count;
        } else {
          const r = await prisma.partnerBonus.updateMany({
            where: { id: act.bonusId, status: "EARNED" },
            data: { status: "REVERSED", reversedAt: now, reverseReason: act.reason },
          });
          reversed += r.count;
        }
      }
    }
  }
  return { earned, reversed, retargeted, attached };
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
  // Только подтверждённые: «на проверке» и отклонённые школе не засчитываются.
  const rows = await prisma.partnerAttribution.findMany({
    where: { ...where, reviewStatus: "CONFIRMED" },
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
    // Поставили заново — это новая привязка: прежняя отметка «прошёл» к ней не относится.
    completedAt: null,
    completedById: null,
  };
  if (previous) await reopenRemovedBonus(previous.id);
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

const REMOVED_REASON = "убран из акции";
const SCHOOL_REMOVED_REASON = "школу убрали";

/**
 * Бонус, снятый вместе с привязкой, снова решает правило — когда привязку
 * поставили заново (§ школьная акция: «поставили заново после снятия — бонус
 * считается заново той же строкой»). Снятие помечалось ручным, и пересчёт
 * такой бонус не трогал никогда: человек возвращался в акцию, приходил на
 * приём, а школа бонуса не получала.
 */
async function reopenRemovedBonus(attributionId: string): Promise<void> {
  await prisma.partnerBonus.updateMany({
    where: { attributionId, status: "REVERSED", reverseReason: REMOVED_REASON },
    data: { manual: false },
  });
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
      data: { status: "REVERSED", reversedAt: new Date(), reverseReason: REMOVED_REASON, manual: true, setById: input.actorId },
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
      waMarker: true,
      schools: { where: { isActive: true }, select: { id: true, name: true } },
      knowledge: {
        where: { isActive: true, OR: [{ needsDoctorApproval: false }, { approvedAt: { not: null } }] },
        orderBy: { createdAt: "asc" },
        select: { id: true, topic: true, question: true, answer: true },
      },
    },
  });
  return rows.map((r) => ({ ...r, waMarker: effectiveMarker(r.waMarker), entries: r.knowledge }));
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

/**
 * Счётчик переходов по короткой ссылке — в общей таблице счётчиков по дням
 * (`FeatureUse`): только число, без адреса, устройства и времени (§7). В список
 * приёмов работы сотрудников (`FEATURES`) он не входит — это не их действие.
 */
export const PROMO_LINK_FEATURE = "promo-link";

/**
 * Куда ведёт короткая ссылка `/children`: WhatsApp клиники с готовым текстом.
 * Акция не идёт (не началась, кончилась, выключена) — WhatsApp без текста:
 * человек со старой листовки всё равно дойдёт до клиники, но не с обещанием
 * акции, которой нет. Нет номера — null.
 */
export async function promoLinkTarget(now = new Date()): Promise<{ companyId: string; url: string; counted: boolean } | null> {
  const promo = await prisma.promo.findFirst({
    where: { waPhone: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { companyId: true, waPhone: true, waMarker: true, isActive: true, startsAt: true, endsAt: true },
  });
  if (!promo) return null;
  const running = promo.isActive && promo.startsAt <= now && now <= promo.endsAt;
  const url = running ? waLink(promo.waPhone, effectiveMarker(promo.waMarker)) : waLink(promo.waPhone, "", "");
  if (!url) return null;
  return { companyId: promo.companyId, url: running ? url : url.replace(/\?text=$/, ""), counted: running };
}

/** +1 переход за день клиники. Счётчик не должен ронять переход. */
export async function notePromoLinkClick(companyId: string): Promise<void> {
  const day = startOfClinicDay();
  await prisma.featureUse
    .upsert({
      where: { companyId_day_feature: { companyId, day, feature: PROMO_LINK_FEATURE } },
      update: { count: { increment: 1 } },
      create: { companyId, day, feature: PROMO_LINK_FEATURE, count: 1 },
    })
    .catch(() => {});
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
  /** Номер WhatsApp клиники для ссылки со школьных материалов. */
  waPhone: "79285169512",
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
  const existing = await prisma.promo.findFirst({
    where: { companyId },
    orderBy: { createdAt: "asc" },
    select: { id: true, items: true, serviceIds: true, waPhone: true, waMarker: true },
  });
  // Прайс нужен только для связывания состава — на каждое открытие экрана его не читаем.
  const priced = async () =>
    (await prisma.service.findMany({ where: { companyId }, select: { yclientsServiceId: true, title: true, price: true } })).map((s) => ({
      ...s,
      price: num(s.price),
    }));
  if (existing) {
    // Акцию завели до того, как у неё появился состав, — дописываем его, ничего не теряя.
    // Номера для ссылки ещё нет — подставляем номер клиники; заданный руками не трогаем.
    if (!existing.waPhone) await prisma.promo.update({ where: { id: existing.id }, data: { waPhone: SCHOOL_PROMO.waPhone } });
    /**
     * Прежняя метка «[ШК]» стояла значением по умолчанию, руками её никто не
     * ставил. Заказчик (20 октября): «школа будет одна, зачем [ШК]» — метка
     * теперь сама фраза «школьный ресурс». Заданную руками иную метку не трогаем.
     */
    if (existing.waMarker.trim() === LEGACY_MARKER) await prisma.promo.update({ where: { id: existing.id }, data: { waMarker: DEFAULT_MARKER } });
    if (itemsOf(existing.items).length === 0) {
      const items = linkItems(await priced());
      // Засчитываемые услуги не трогаем: состав — для пациента и агента (см. ниже).
      await prisma.promo.update({ where: { id: existing.id }, data: { items: items as unknown as object[] } });
    }
    return existing.id;
  }
  const items = linkItems(await priced());
  const endsAt = new Date(clinicDayRange(new Date(`${SCHOOL_PROMO.endsOn}T12:00:00Z`)).end.getTime() - 1);
  /**
   * Два первых открытия экрана в одну секунду (две вкладки) — обе дошли бы до
   * создания, и вторая упала бы на уникальности (клиника, slug) ошибкой на
   * весь экран. Проигравшая берёт то, что создала первая.
   */
  const created = await prisma.promo
    .create({
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
        waPhone: SCHOOL_PROMO.waPhone,
        waMarker: DEFAULT_MARKER,
        items: items as unknown as object[],
        /**
         * Засчитываемые услуги новой акции — только пойманные по названию
         * («Школьный ресурс 6+» и части). Обычные строки, совпавшие с позициями
         * состава («детский приём остеопата 4000»), сюда не идут: иначе любой
         * обычный детский приём привязанного пациента стал бы визитом акции.
         */
        serviceIds: [],
      },
      select: { id: true },
    })
    .catch(async (e) => {
      const again = await prisma.promo.findFirst({ where: { companyId }, orderBy: { createdAt: "asc" }, select: { id: true } });
      if (again) return again;
      throw e;
    });
  return created.id;
}

export type ParticipantStatus = "waiting" | "done" | "bonus" | "reversed" | "no_school" | "returning";

export interface PromoParticipant {
  attributionId: string;
  patientId: string;
  patientName: string;
  phoneTail: string | null;
  schoolId: string | null;
  schoolName: string | null;
  childNo: number;
  isExtraChild: boolean;
  note: string | null;
  source: "ADMIN" | "AGENT";
  confidence: "MARKER" | "AI_EVIDENCE" | "MANUAL";
  reviewStatus: "CONFIRMED" | "REVIEW" | "REJECTED";
  returning: boolean;
  evidenceQuote: string | null;
  conversationId: string | null;
  attributedAt: string;
  createdBy: string | null;
  completedAt: string | null;
  status: ParticipantStatus;
  bonus: { status: "EARNED" | "REVERSED"; amount: number; manual: boolean; reason: string | null; at: string } | null;
}

/** Строка состава услуг акции на экране. */
export interface PromoServiceRow {
  yclientsServiceId: number;
  title: string;
  price: number;
  /** chosen — выбрана руками; keyword — поймана по названию; excluded — исключена руками. */
  how: "chosen" | "keyword" | "excluded";
}

export interface PromoStats {
  byMarker: number;
  byEvidence: number;
  manual: number;
  inReview: number;
  /** Повторные пациенты: привязка есть, бонуса нет. */
  returning: number;
  /** Привязанные (подтверждённые), у кого есть живой визит акции. */
  booked: number;
  /** Привязанные (подтверждённые), у кого визит акции «пришёл». */
  arrived: number;
  bonusCount: number;
  bonusEarned: number;
  reversed: number;
  /**
   * Визиты акции без источника: пациент пришёл или записан на услугу акции, а
   * привязки нет. Не прячем — это честное число непривязанных.
   */
  visitsWithoutSource: number;
  /** Переходов по короткой ссылке `/children` с начала акции (без превью мессенджеров). */
  linkClicks: number;
}

export interface NoticeMismatchRow {
  messageId: string;
  conversationId: string;
  patientName: string | null;
  at: string;
  kind: "booked-missing" | "cancelled-alive" | "no-card";
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
  aiReviewEnabled: boolean;
  open: boolean;
  waMarker: string;
  waPhone: string | null;
  waLink: string | null;
  serviceKeywords: string[];
  promoServices: PromoServiceRow[];
  serviceWarnings: string[];
  items: (PromoItem & { serviceTitle: string | null })[];
  services: { yclientsServiceId: number; title: string; price: number }[];
  schools: {
    id: string;
    name: string;
    aliases: string[];
    contactName: string | null;
    contactPhone: string | null;
    isActive: boolean;
    reportToken: string;
    totals: SchoolTotals;
  }[];
  participants: PromoParticipant[];
  review: PromoParticipant[];
  stats: PromoStats;
  mismatches: NoticeMismatchRow[];
  totals: SchoolTotals;
  knowledge: PromoDetail["knowledge"];
}

function statusOf(a: {
  schoolId: string | null;
  completedAt: Date | null;
  returningPatient: boolean;
  bonus: { status: string } | null;
}): ParticipantStatus {
  if (a.bonus?.status === "EARNED") return "bonus";
  if (a.bonus?.status === "REVERSED") return "reversed";
  if (a.completedAt) return "done";
  if (!a.schoolId) return "no_school";
  if (a.returningPatient) return "returning";
  return "waiting";
}

/**
 * Агент об акции молчит, и это должно быть видно на экране. Записи акции с
 * анализами и противопоказаниями создаются выключенными до утверждения врачом
 * или владельцем, а без включённых записей агент акции не видит вовсе: на
 * «интересует школьный чек-ап» он отвечал «уточню у администратора» и путал её
 * с чек-апами для капельниц (живой диалог 21 октября).
 */
function agentWarnings(
  p: { agentEnabled: boolean },
  knowledge: { isActive: boolean; needsDoctorApproval: boolean; approvedAt: Date | null }[],
): string[] {
  const usable = knowledge.filter((k) => k.isActive && (!k.needsDoctorApproval || k.approvedAt));
  const waiting = knowledge.filter((k) => k.needsDoctorApproval && !k.approvedAt).length;
  if (!p.agentEnabled) return ["Агент об акции не рассказывает: выключено «Агент рассказывает об акции» в условиях ниже."];
  if (usable.length > 0) return [];
  if (waiting > 0)
    return [`Агент об акции молчит: ${waiting === 1 ? "запись ждёт" : `${waiting} записи ждут`} утверждения врачом или владельцем — «Утвердить текст как врач» в блоке «Что агент знает об акции».`];
  return ["Агент об акции молчит: нет ни одной включённой записи в блоке «Что агент знает об акции»."];
}

/** Предупреждение о составе — словами, для экрана. */
function warningText(w: PromoServiceWarning, titleOf: (id: number) => string): string {
  if (w.kind === "renamed") return `Услуга «${w.was}» переименована в YCLIENTS в «${w.now}» — проверьте, что она всё ещё про акцию.`;
  if (w.kind === "missing")
    return `Услуги «${w.was ?? titleOf(w.yclientsServiceId)}» (${w.yclientsServiceId}) больше нет в YCLIENTS — визиты по ней не придут.`;
  if (w.kind === "unlike")
    return `Выбрана услуга «${w.title}» — по названию она не про акцию. Её обычные приёмы считаются визитами акции и дают бонус школе. Если она здесь случайно — снимите её в настройках ниже.`;
  return `Услуга «${w.title}» выключена в YCLIENTS.`;
}

const attributionSelect = {
  id: true,
  patientId: true,
  schoolId: true,
  childNo: true,
  isExtraChild: true,
  note: true,
  source: true,
  confidence: true,
  reviewStatus: true,
  returningPatient: true,
  evidenceQuote: true,
  conversationId: true,
  attributedAt: true,
  createdById: true,
  completedAt: true,
  removedAt: true,
  patient: { select: { name: true, phones: { take: 1, orderBy: { isPrimary: "desc" as const }, select: { phone: true } } } },
  school: { select: { name: true } },
  bonus: { select: { status: true, amount: true, manual: true, reverseReason: true, earnedAt: true, reversedAt: true } },
} as const;

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
    // Одним запросом и действующие, и снятые: снятые нужны только итогам.
    prisma.partnerAttribution.findMany({
      where: { companyId, promoId: id },
      orderBy: { attributedAt: "desc" },
      select: attributionSelect,
    }),
    prisma.knowledgeEntry.findMany({
      where: { companyId, promoId: id },
      orderBy: { createdAt: "asc" },
      select: { id: true, topic: true, question: true, answer: true, isActive: true, needsDoctorApproval: true, approvedAt: true },
    }),
  ]);
  const live = rows.filter((r) => r.removedAt == null && r.reviewStatus !== "REJECTED");
  const confirmed = live.filter((r) => r.reviewStatus === "CONFIRMED");
  const staffIds = [...new Set(live.map((r) => r.createdById).filter((x): x is string => Boolean(x)))];
  const staff = staffIds.length ? await prisma.staffUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }) : [];
  const staffName = new Map(staff.map((u) => [u.id, u.name]));

  // Итоги — только подтверждённые привязки: «на проверке» школе ещё не засчитано.
  const counted = rows.filter((r) => r.reviewStatus === "CONFIRMED");
  const totalsOf = (filter: (r: (typeof rows)[number]) => boolean) =>
    schoolTotals(
      counted
        .filter(filter)
        .map((r) => ({ removed: r.removedAt != null, bonus: r.bonus ? { status: r.bonus.status, amount: num(r.bonus.amount) } : null })),
    );

  const catalog: CatalogService[] = services.map((s) => ({ yclientsServiceId: s.yclientsServiceId, title: s.title, isActive: s.isActive }));
  const set = serviceSetOf(p, catalog);
  const svcById = new Map(services.map((s) => [s.yclientsServiceId!, s]));
  const titleOf = (n: number) => svcById.get(n)?.title ?? String(n);
  const serviceRow = (n: number, how: PromoServiceRow["how"]): PromoServiceRow => ({
    yclientsServiceId: n,
    title: titleOf(n),
    price: num(svcById.get(n)?.price),
    how,
  });

  // Визиты акции всех пациентов — для «записались», «пришли» и «без источника».
  const rule = { serviceIds: set.ids, startsAt: p.startsAt, endsAt: p.endsAt };
  const records = set.ids.length
    ? await prisma.appointment.findMany({
        where: {
          companyId,
          startAt: { gte: p.startsAt, lte: graceEnd(p) },
          services: { some: { service: { yclientsServiceId: { in: set.ids } } } },
        },
        select: {
          id: true,
          yclientsVisitId: true,
          patientId: true,
          startAt: true,
          status: true,
          deletedAt: true,
          services: { select: { quantity: true, service: { select: { yclientsServiceId: true } } } },
        },
      })
    : [];
  const visitsByPatient = new Map<string, ReturnType<typeof promoVisits>>();
  for (const pid of new Set(records.map((r) => r.patientId))) {
    visitsByPatient.set(
      pid,
      promoVisits(
        rule,
        records
          .filter((r) => r.patientId === pid)
          .map((r) => ({
            id: r.id,
            startAt: r.startAt,
            status: r.status,
            deleted: r.deletedAt != null,
            visitKey: visitKeyOf(r),
            services: r.services.map((x) => ({ yclientsServiceId: x.service.yclientsServiceId, quantity: x.quantity })),
          })),
      ),
    );
  }
  const liveVisit = (v: ReturnType<typeof promoVisits>[number]) => v.records.some((r) => !r.deleted && r.status !== "CANCELLED");
  const confirmedPatients = new Set(confirmed.map((r) => r.patientId));
  const anyAttributed = new Set(live.map((r) => r.patientId));
  let visitsWithoutSource = 0;
  for (const [pid, visits] of visitsByPatient) {
    if (anyAttributed.has(pid)) continue;
    visitsWithoutSource += visits.filter(liveVisit).length;
  }
  const earned = confirmed.filter((r) => r.bonus?.status === "EARNED");
  const clicks = await prisma.featureUse.aggregate({
    where: { companyId, feature: PROMO_LINK_FEATURE, day: { gte: startOfClinicDay(p.startsAt) } },
    _sum: { count: true },
  });
  const stats: PromoStats = {
    byMarker: confirmed.filter((r) => r.confidence === "MARKER").length,
    byEvidence: confirmed.filter((r) => r.confidence === "AI_EVIDENCE").length,
    manual: confirmed.filter((r) => r.confidence === "MANUAL").length,
    inReview: live.filter((r) => r.reviewStatus === "REVIEW").length,
    returning: confirmed.filter((r) => r.returningPatient).length,
    booked: [...confirmedPatients].filter((pid) => (visitsByPatient.get(pid) ?? []).some(liveVisit)).length,
    arrived: [...confirmedPatients].filter((pid) => (visitsByPatient.get(pid) ?? []).some((v) => v.arrivedRecordId)).length,
    bonusCount: earned.length,
    bonusEarned: earned.reduce((t, r) => t + num(r.bonus!.amount), 0),
    reversed: confirmed.filter((r) => r.bonus?.status === "REVERSED").length,
    visitsWithoutSource,
    linkClicks: clicks._sum.count ?? 0,
  };

  const participant = (r: (typeof rows)[number]): PromoParticipant => ({
    attributionId: r.id,
    patientId: r.patientId,
    patientName: r.patient.name ?? "без имени",
    phoneTail: r.patient.phones[0]?.phone.slice(-4) ?? null,
    schoolId: r.schoolId,
    schoolName: r.school?.name ?? null,
    childNo: r.childNo,
    isExtraChild: r.isExtraChild,
    note: r.note,
    source: r.source,
    confidence: r.confidence,
    reviewStatus: r.reviewStatus,
    returning: r.returningPatient,
    evidenceQuote: r.evidenceQuote,
    conversationId: r.conversationId,
    attributedAt: r.attributedAt.toISOString(),
    createdBy:
      r.confidence === "MARKER"
        ? "по метке в ссылке"
        : r.confidence === "AI_EVIDENCE"
          ? "по переписке"
          : r.source === "AGENT"
            ? "агент"
            : r.createdById
              ? (staffName.get(r.createdById) ?? null)
              : null,
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
  });

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
    aiReviewEnabled: p.aiReviewEnabled,
    open: canAttribute(p, now),
    waMarker: effectiveMarker(p.waMarker),
    waPhone: p.waPhone,
    waLink: waLink(p.waPhone, effectiveMarker(p.waMarker)),
    serviceKeywords: p.serviceKeywords,
    promoServices: [
      ...set.chosen.map((n) => serviceRow(n, "chosen")),
      ...set.byKeyword.map((n) => serviceRow(n, "keyword")),
      ...set.excluded.map((n) => serviceRow(n, "excluded")),
    ],
    serviceWarnings: [...set.warnings.map((w) => warningText(w, titleOf)), ...agentWarnings(p, knowledge)],
    items: items.map((i) => ({ ...i, serviceTitle: i.yclientsServiceId ? (byYc.get(i.yclientsServiceId) ?? null) : null })),
    services: services
      .filter((s) => s.isActive)
      .map((s) => ({ yclientsServiceId: s.yclientsServiceId!, title: s.title, price: num(s.price) })),
    schools: schools.map((s) => ({
      id: s.id,
      name: s.name,
      aliases: s.aliases,
      contactName: s.contactName,
      contactPhone: s.contactPhone,
      isActive: s.isActive,
      reportToken: s.reportToken,
      totals: totalsOf((r) => r.schoolId === s.id),
    })),
    participants: live.filter((r) => r.reviewStatus === "CONFIRMED").map(participant),
    review: live.filter((r) => r.reviewStatus === "REVIEW").map(participant),
    stats,
    mismatches: await noticeMismatches(companyId, p, set.ids),
    totals: totalsOf(() => true),
    knowledge: knowledge.map((k) => ({ ...k, approvedAt: k.approvedAt?.toISOString() ?? null })),
  };
}

/**
 * Сверка с уведомлениями YCLIENTS (только флаг). Уведомление о записи на
 * услугу акции, а записи у нас нет; или отмена, а запись жива. Из уведомлений
 * ничего не создаётся: источник истины — API YCLIENTS (§2).
 */
async function noticeMismatches(
  companyId: string,
  promo: { startsAt: Date; endsAt: Date; serviceKeywords: string[] },
  ids: number[],
): Promise<NoticeMismatchRow[]> {
  const keywords = promo.serviceKeywords.filter((k) => k.trim().length >= 3);
  if (keywords.length === 0) return [];
  const messages = await prisma.message.findMany({
    where: {
      companyId,
      direction: "OUT",
      authorType: "STAFF",
      deletedAt: null,
      createdAt: { gte: promo.startsAt },
      OR: keywords.map((k) => ({ body: { contains: k.trim(), mode: "insensitive" as const } })),
      conversation: { isPractice: false },
    },
    orderBy: { createdAt: "asc" },
    take: 500,
    select: { id: true, body: true, createdAt: true, conversationId: true, conversation: { select: { patientId: true, patient: { select: { name: true } } } } },
  });
  // Последнее уведомление на один приём решает: «записаны», потом «отменена» — значит отменена.
  const latest = new Map<string, { m: (typeof messages)[number]; notice: ParsedNotice; at: Date }>();
  for (const m of messages) {
    const notice = parseNotice(m.body);
    if (!notice || !noticeAboutPromo(notice, keywords)) continue;
    const { year, month, day, hour, minute } = notice.local;
    const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const at = clinicMoment(key, hour * 60 + minute, CLINIC_TZ);
    latest.set(`${m.conversationId}|${at.toISOString()}`, { m, notice, at });
  }
  const out: NoticeMismatchRow[] = [];
  for (const { m, notice, at } of latest.values()) {
    const patientId = m.conversation.patientId;
    if (!patientId) {
      out.push({ messageId: m.id, conversationId: m.conversationId, patientName: null, at: at.toISOString(), kind: "no-card" });
      continue;
    }
    const near = await prisma.appointment.findMany({
      where: {
        companyId,
        patientId,
        startAt: { gte: new Date(at.getTime() - 10 * 60_000), lte: new Date(at.getTime() + 10 * 60_000) },
        ...(ids.length ? { services: { some: { service: { yclientsServiceId: { in: ids } } } } } : {}),
      },
      select: { status: true, deletedAt: true },
    });
    const kind = noticeMismatch(notice, near.map((r) => ({ status: r.status, deleted: r.deletedAt != null })));
    if (kind) out.push({ messageId: m.id, conversationId: m.conversationId, patientName: m.conversation.patient?.name ?? null, at: at.toISOString(), kind });
  }
  return out;
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
    select: { id: true },
  });
  if (!a) throw new Error("Участник не найден или уже убран из акции.");
  await prisma.partnerAttribution.update({ where: { id: a.id }, data: { completedAt: now, completedById: actorId } });
  await earnManualBonus(companyId, actorId, a.id, now);
}

/** Ручной бонус школе за участника; без школы — нечего начислять. */
async function earnManualBonus(companyId: string, actorId: string | null, attributionId: string, now: Date): Promise<void> {
  const a = await prisma.partnerAttribution.findFirst({
    where: { id: attributionId, companyId, removedAt: null },
    select: { id: true, schoolId: true, bonusAmountFrozen: true, bonus: { select: { id: true } } },
  });
  if (!a?.schoolId) return;
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

/**
 * Сменить школу участника (или убрать её). Бонус переходит за школой; без
 * школы — снимается. Школу вернули — бонус, снятый из-за её отсутствия,
 * возвращается; участник уже отмечен «прошёл», а школу поставили позже —
 * бонус начисляется сейчас: иначе отметка «прошёл» без школы навсегда
 * оставляла школу без бонуса.
 */
export async function setParticipantSchool(companyId: string, actorId: string | null, attributionId: string, schoolId: string | null): Promise<void> {
  if (schoolId) {
    const ok = await prisma.partnerSchool.findFirst({ where: { id: schoolId, companyId, isActive: true }, select: { id: true } });
    if (!ok) throw new Error("Школа не найдена или выключена.");
  }
  const a = await prisma.partnerAttribution.findFirst({
    where: { id: attributionId, companyId, removedAt: null },
    select: { id: true, completedAt: true, bonus: { select: { status: true, reverseReason: true, triggeredByAppointmentId: true } } },
  });
  if (!a) throw new Error("Участник не найден.");
  await prisma.partnerAttribution.update({ where: { id: a.id }, data: { schoolId } });
  if (schoolId) {
    await prisma.partnerBonus.updateMany({ where: { attributionId }, data: { schoolId } });
    if (a.bonus?.status === "REVERSED" && a.bonus.reverseReason === SCHOOL_REMOVED_REASON) {
      await prisma.partnerBonus.updateMany({
        where: { attributionId, status: "REVERSED" },
        // Бонус по визиту снова решает правило: отменят визит — снимется сам.
        data: { status: "EARNED", reversedAt: null, reverseReason: null, manual: a.bonus.triggeredByAppointmentId == null, setById: actorId },
      });
    } else if (a.completedAt && !a.bonus) {
      await earnManualBonus(companyId, actorId, a.id, new Date());
    }
  } else
    await prisma.partnerBonus.updateMany({
      where: { attributionId, status: "EARNED" },
      data: { status: "REVERSED", reversedAt: new Date(), reverseReason: SCHOOL_REMOVED_REASON, manual: true, setById: actorId },
    });
  await recomputePartnerBonuses(companyId);
}
