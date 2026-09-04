import { prisma } from "@/lib/db";
import { getClinicSettings } from "@/app/(dashboard)/settings/clinic/actions";
import { periodBounds, periodLabel } from "@/lib/server/analytics";
import type { PeriodKey } from "@/lib/metrics/types";
import {
  courseCompletion,
  courseRepurchase,
  medianOf,
  outstandingCourseValue,
  sessionInterval,
  REPURCHASE_WINDOW_DAYS,
  type CourseCompletion,
  type CourseFact,
  type CourseRepurchase,
  type OutstandingCourses,
  type RepurchaseInput,
} from "@/lib/metrics/courses";

/**
 * Экономика курсов — из базы.
 *
 * Чтение и склейка; четыре метрики считают чистые функции
 * `lib/metrics/courses.ts` и они же покрыты тестами. Отчёты, кабинет
 * владельца и ИИ-аналитик читают эти числа отсюда — одна метрика, одна
 * функция (§8).
 */

export interface ServiceRhythm {
  serviceTitle: string;
  /** Медиана дней между сеансами по всем курсам этой услуги. */
  medianDays: number | null;
  meanDays: number | null;
  /** Сколько промежутков легло в расчёт: по одному сеансу ритма не видно. */
  gaps: number;
  courses: number;
}

export interface CourseEconomics {
  completion: CourseCompletion;
  outstanding: OutstandingCourses;
  repurchase: CourseRepurchase;
  rhythm: ServiceRhythm[];
  /** Курсы вообще есть? Пусто — так и пишем, а не рисуем нули. */
  hasCourses: boolean;
  periodLabel: string;
}

/** Все курсы клиники в виде, понятном чистым функциям. */
async function courseFacts(companyId: string): Promise<CourseFact[]> {
  const clinic = await getClinicSettings();
  const fallback = clinic.stalledDefaultDays;

  const rows = await prisma.course.findMany({
    where: { companyId, status: { in: ["ACTIVE", "COMPLETED"] } },
    select: {
      id: true,
      patientId: true,
      purchasedAt: true,
      sessionsTotal: true,
      sessionsUsed: true,
      sessionsBooked: true,
      pricePerSession: true,
      service: { select: { title: true, stalledAfterDays: true } },
      appointments: {
        where: { deletedAt: null },
        select: { startAt: true, status: true },
        orderBy: { startAt: "asc" },
      },
    },
  });

  const now = new Date();
  return rows.map((c) => ({
    courseId: c.id,
    patientId: c.patientId,
    serviceTitle: c.service.title,
    purchasedAt: c.purchasedAt,
    sessionsTotal: c.sessionsTotal,
    sessionsUsed: c.sessionsUsed,
    sessionsBooked: c.sessionsBooked,
    pricePerSession: Number(c.pricePerSession),
    sessionDates: c.appointments.filter((a) => a.status === "ARRIVED").map((a) => a.startAt),
    thresholdDays: c.service.stalledAfterDays ?? fallback,
    hasFuture: c.appointments.some((a) => a.startAt > now && a.status !== "CANCELLED"),
  }));
}

export async function getCourseEconomics(
  companyId: string,
  period: PeriodKey,
): Promise<CourseEconomics> {
  const { from, to } = periodBounds(period);
  const now = new Date();
  const facts = await courseFacts(companyId);

  /** Доходимость — по курсам, купленным в периоде: это когорта периода. */
  const ofPeriod = facts.filter((c) => c.purchasedAt >= from && c.purchasedAt < to);

  /**
   * Обязательства — всегда «на сейчас», а не за период. Деньги, которые
   * клиника должна отработать, не бывают «за август»: они либо висят, либо
   * нет.
   */
  const outstanding = outstandingCourseValue(facts, now);

  /**
   * Повторные покупки: когорта — курсы, ЗАКОНЧЕННЫЕ в периоде. Купившие
   * второй курс ищутся по всем покупкам пациента, а не только за период:
   * возврат случается позже, чем кончился первый курс.
   */
  const finished = facts.filter(
    (c) => c.sessionsUsed >= c.sessionsTotal && c.sessionDates.length > 0,
  );
  const finishedInPeriod = finished.filter((c) => {
    const last = c.sessionDates[c.sessionDates.length - 1];
    return last >= from && last < to;
  });

  const purchases = finishedInPeriod.length
    ? await prisma.coursePurchase.findMany({
        where: {
          companyId,
          isCourse: true,
          patientId: { in: [...new Set(finishedInPeriod.map((c) => c.patientId))] },
        },
        select: { patientId: true, purchasedAt: true },
      })
    : [];
  const byPatient = new Map<string, Date[]>();
  for (const p of purchases) {
    const list = byPatient.get(p.patientId);
    if (list) list.push(p.purchasedAt);
    else byPatient.set(p.patientId, [p.purchasedAt]);
  }

  const repurchaseInput: RepurchaseInput[] = finishedInPeriod.map((c) => ({
    patientId: c.patientId,
    finishedAt: c.sessionDates[c.sessionDates.length - 1],
    laterPurchases: byPatient.get(c.patientId) ?? [],
  }));

  /** Ритм по услугам: как часто на самом деле ходят на БОС и на капельницы. */
  const rhythmAcc = new Map<string, { gaps: number[]; courses: number }>();
  for (const c of facts) {
    const iv = sessionInterval(c.sessionDates);
    if (iv.gaps === 0) continue;
    const acc = rhythmAcc.get(c.serviceTitle) ?? { gaps: [], courses: 0 };
    // Промежутки складываем, а не медианы медиан: курс из двух сеансов не
    // должен весить столько же, сколько курс из десяти.
    const ordered = [...c.sessionDates].sort((a, b) => a.getTime() - b.getTime());
    for (let i = 1; i < ordered.length; i++) {
      acc.gaps.push(Math.round((ordered[i].getTime() - ordered[i - 1].getTime()) / 86_400_000));
    }
    acc.courses += 1;
    rhythmAcc.set(c.serviceTitle, acc);
  }

  const rhythm: ServiceRhythm[] = [...rhythmAcc]
    .map(([serviceTitle, v]) => ({
      serviceTitle,
      medianDays: medianOf(v.gaps),
      meanDays: v.gaps.length ? v.gaps.reduce((a, b) => a + b, 0) / v.gaps.length : null,
      gaps: v.gaps.length,
      courses: v.courses,
    }))
    .sort((a, b) => b.courses - a.courses);

  return {
    completion: courseCompletion(ofPeriod, now),
    outstanding,
    repurchase: courseRepurchase(repurchaseInput, now, REPURCHASE_WINDOW_DAYS),
    rhythm,
    hasCourses: facts.length > 0,
    periodLabel: periodLabel(period),
  };
}
