import { prisma } from "@/lib/db";
import { clinicMinuteOfDay } from "@/lib/clinic-time";
import {
  buildPatientProfile,
  type PatientProfile,
  type ProfileMessage,
  type ProfileVisit,
} from "@/lib/metrics/patient-profile";

/**
 * Личное дело пациента — из базы.
 *
 * Чтение и склейка; все выводы делает чистая функция
 * `lib/metrics/patient-profile.ts`, она же покрыта тестами.
 *
 * Тексты сообщений читаются, но НИКУДА не отправляются: разбор идёт здесь, на
 * нашем сервере, по своим правилам. Переписка с клиникой — врачебная тайна
 * (ст. 13 323-ФЗ) и персональные данные (§7); отправить её во внешнюю модель
 * ради «красивого портрета» нельзя, сколько бы пользы это ни обещало.
 */

export interface PatientDossier extends PatientProfile {
  /** Курсы: сколько оплачено вперёд и сколько пройдено. */
  courses: {
    title: string;
    used: number;
    total: number;
    booked: number;
    status: string;
  }[];
  /** Канал, в котором с человеком говорят, и когда он писал последний раз. */
  contact: {
    channel: string | null;
    lastInboundAt: Date | null;
    dialogs: number;
  };
  /** Источник обращения и насколько он известен (§8). */
  source: { title: string | null; confidence: string } | null;
  /**
   * Части, которые не прочитались.
   *
   * Дело собирается из трёх независимых чтений, и раньше падение любого из них
   * роняло весь раздел: человек видел «Личное дело не собралось… обновите
   * страницу» вместо визитов, которые прочитались прекрасно. Теперь отдаётся
   * то, что есть, а несобравшееся названо словами — и не выдаётся за ноль
   * («визитов не было» там, где визиты просто не прочитались, — ложь про
   * пациента).
   */
  missing: DossierPart[];
}

/** Части дела, каждая со своим чтением. */
export type DossierPart = "visits" | "messages" | "courses";

export async function getPatientDossier(
  companyId: string,
  patientId: string,
): Promise<PatientDossier | null> {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, companyId, deletedAt: null },
    select: { id: true },
  });
  if (!patient) return null;

  const [apptsRes, conversationsRes, coursesRes] = await Promise.allSettled([
    prisma.appointment.findMany({
      where: { companyId, patientId, deletedAt: null },
      select: {
        startAt: true,
        status: true,
        revenue: true,
        sourceId: true,
        sourceConfidence: true,
        createdAtYclients: true,
        staff: { select: { name: true } },
        primaryService: { select: { title: true } },
        services: { select: { priceCharged: true, service: { select: { title: true } } } },
        source: { select: { title: true } },
      },
      orderBy: { startAt: "asc" },
    }),
    prisma.conversation.findMany({
      where: { companyId, patientId, deletedAt: null },
      select: {
        channel: true,
        lastPatientMessageAt: true,
        messages: {
          where: { deletedAt: null, isDraft: false },
          select: {
            direction: true,
            authorType: true,
            body: true,
            createdAt: true,
            attachments: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { lastMessageAt: "desc" },
    }),
    prisma.course.findMany({
      where: { companyId, patientId },
      select: {
        sessionsTotal: true,
        sessionsUsed: true,
        sessionsBooked: true,
        status: true,
        service: { select: { title: true } },
      },
      orderBy: { purchasedAt: "desc" },
    }),
  ]);

  /**
   * Чтения разбираются порознь: упавшее не отменяет прочитанное.
   * Причина уходит в лог сервера, а не пациенту на экран — там от неё пользы
   * нет, а имя и телефон в неё попасть не должны (§7).
   */
  const missing: DossierPart[] = [];
  function taken<T>(res: PromiseSettledResult<T>, part: DossierPart, fallback: T): T {
    if (res.status === "fulfilled") return res.value;
    console.error(`[личное дело] ${part}: ${(res.reason as Error)?.message ?? String(res.reason)}`);
    missing.push(part);
    return fallback;
  }
  const appts = taken(apptsRes, "visits", []);
  const conversations = taken(conversationsRes, "messages", []);
  const courses = taken(coursesRes, "courses", []);

  const visits: ProfileVisit[] = appts.map((a) => ({
    at: a.startAt,
    status: a.status,
    staffName: a.staff?.name ?? null,
    /**
     * Состав визита, а не первая услуга: у записи их бывает несколько, и
     * «Взрослый приём — 13 000 ₽» противоречило прайсу ровно из-за этого (§8).
     * Состава ещё нет у старых записей — тогда основная услуга и сумма визита.
     */
    services:
      a.services.length > 0
        ? a.services.map((s) => ({ title: s.service.title, amount: Number(s.priceCharged) }))
        : a.primaryService
          ? [{ title: a.primaryService.title, amount: Number(a.revenue) }]
          : [],
    revenue: Number(a.revenue),
  }));

  const messages: ProfileMessage[] = [];
  for (const c of conversations) {
    for (const m of c.messages) {
      messages.push({
        direction: m.direction,
        authorType: m.authorType,
        body: m.body,
        at: m.createdAt,
        hasAttachment: Array.isArray(m.attachments) && m.attachments.length > 0,
        // Час в зоне клиники: по UTC вечерний пациент выглядел бы дневным.
        clinicHour: Math.floor(clinicMinuteOfDay(m.createdAt) / 60),
      });
    }
  }

  const profile = buildPatientProfile(visits, messages);

  /**
   * Источник — по самой ранней записи: он отвечает на вопрос «откуда пришёл»,
   * а не «как записался в прошлый раз».
   */
  const withSource = appts.find((a) => a.sourceId !== null);

  return {
    ...profile,
    courses: courses.map((c) => ({
      title: c.service.title,
      used: c.sessionsUsed,
      total: c.sessionsTotal,
      booked: c.sessionsBooked,
      status: c.status,
    })),
    contact: {
      channel: conversations[0]?.channel ?? null,
      lastInboundAt: conversations[0]?.lastPatientMessageAt ?? null,
      dialogs: conversations.length,
    },
    source: withSource
      ? { title: withSource.source?.title ?? null, confidence: withSource.sourceConfidence }
      : null,
    missing,
  };
}
