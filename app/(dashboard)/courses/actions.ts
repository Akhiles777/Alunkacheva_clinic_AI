"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { clinicDateKey, startOfClinicDay } from "@/lib/clinic-time";

/**
 * Курсы пациентов для экранов.
 *
 * Раздел «Курсы», плитка в аналитике пациентов и строка «выпали из курса» на
 * «Сегодня» читали курсы из стора, а в стор они не попадали никогда: при
 * загрузке пациенту проставлялся пустой список. Экраны были живыми, данных за
 * ними не было — пустота выглядела как «не доехало».
 *
 * Теперь курс собирается из записей YCLIENTS (см. lib/courses/link.ts), и
 * читать его можно по-настоящему.
 */
export interface CourseRecord {
  patientId: string;
  id: string;
  title: string;
  used: number;
  total: number;
  status: "active" | "stalled" | "done";
  /** Подпись последнего сеанса: «сегодня», «3 дн.». */
  lastVisit: string;
  /** Он же числом — чтобы экраны не разбирали подпись обратно. */
  daysAgo: number | null;
  hasFuture: boolean;
  /** Цена сеанса из курса: деньги уже получены, это доля отработки. */
  pricePerSession: number;
}

/** Сколько дней без сеанса считается «выпал» — по умолчанию две недели. */
const STALLED_DEFAULT_DAYS = 14;

export async function getCoursesForStore(): Promise<CourseRecord[]> {
  const session = await getSession();
  const now = new Date();
  const today = startOfClinicDay(now);

  const courses = await prisma.course.findMany({
    where: { companyId: session.companyId, status: { in: ["ACTIVE", "COMPLETED"] } },
    select: {
      id: true,
      patientId: true,
      sessionsTotal: true,
      sessionsUsed: true,
      pricePerSession: true,
      status: true,
      service: { select: { title: true, stalledAfterDays: true } },
      appointments: {
        where: { deletedAt: null, status: { not: "CANCELLED" } },
        select: { startAt: true },
        orderBy: { startAt: "desc" },
      },
    },
  });
  if (courses.length === 0) return [];

  /**
   * Будущая запись ищется по пациенту и услуге, а не по курсу.
   *
   * Следующий сеанс к курсу привяжется только после выгрузки, когда он уже
   * состоится. Пока он впереди, связи нет — и курс без неё выглядел бы
   * выпавшим при том, что человек записан на завтра.
   */
  const ahead = await prisma.appointment.findMany({
    where: {
      companyId: session.companyId,
      deletedAt: null,
      status: { not: "CANCELLED" },
      startAt: { gte: today },
      patientId: { in: [...new Set(courses.map((c) => c.patientId))] },
    },
    select: { patientId: true, primaryServiceId: true, services: { select: { serviceId: true } } },
  });
  const futureKeys = new Set<string>();
  for (const a of ahead) {
    const ids = new Set(a.services.map((s) => s.serviceId));
    if (a.primaryServiceId) ids.add(a.primaryServiceId);
    for (const id of ids) futureKeys.add(`${a.patientId}|${id}`);
  }

  const serviceIdOf = await prisma.course.findMany({
    where: { id: { in: courses.map((c) => c.id) } },
    select: { id: true, serviceId: true },
  });
  const svcByCourse = new Map(serviceIdOf.map((r) => [r.id, r.serviceId]));

  const todayKey = clinicDateKey(now);
  return courses.map((c) => {
    const last = c.appointments[0]?.startAt ?? null;
    const daysAgo =
      last === null
        ? null
        : Math.max(0, Math.round((today.getTime() - startOfClinicDay(last).getTime()) / 86_400_000));
    const hasFuture = futureKeys.has(`${c.patientId}|${svcByCourse.get(c.id) ?? ""}`);
    const limit = c.service.stalledAfterDays ?? STALLED_DEFAULT_DAYS;
    const done = c.status === "COMPLETED" || c.sessionsUsed >= c.sessionsTotal;
    return {
      patientId: c.patientId,
      id: c.id,
      title: c.service.title,
      used: c.sessionsUsed,
      total: c.sessionsTotal,
      status: done ? "done" : !hasFuture && daysAgo !== null && daysAgo > limit ? "stalled" : "active",
      lastVisit:
        last === null
          ? "нет сеансов"
          : clinicDateKey(last) === todayKey
            ? "сегодня"
            : `${daysAgo} дн.`,
      daysAgo,
      hasFuture,
      pricePerSession: Number(c.pricePerSession),
    } satisfies CourseRecord;
  });
}
