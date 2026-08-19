import { prisma } from "@/lib/db";
import { buildCourses, pricePerSession, type CourseVisit } from "./build";

/**
 * Собрать курсы из выгруженных записей и привязать к ним сеансы.
 *
 * Запускается после выгрузки визитов. Смысл шага — объяснить нули: у сеанса
 * курса стоимость в записи нулевая, потому что деньги приняты в день продажи,
 * и без курса на экране остаётся необъяснимый «0 ₽». С курсом видно «сеанс 4
 * из 10 по курсу от 3 августа».
 *
 * Выручку шаг не трогает вовсе. Сумма курса — это стоимость записи дня
 * продажи, она уже посчитана в выручке того дня; здесь она только
 * переписывается в карточку курса. Складывать её с чем-либо ещё нельзя.
 *
 * Пересобирается каждый раз заново из записей: записи — источник истины (§2),
 * а курс — их производная. Так перенос и отмена сеанса разбираются сами, без
 * отдельной логики починки.
 *
 * Пишем только то, что действительно изменилось. Шаг идёт каждые полчаса, и
 * безусловная перезапись ставила бы свежее время изменения тысяче визитов —
 * ровно та беда, из-за которой в выгрузке появилась проверка `recordChanged`:
 * на вопрос «что изменилось за сутки» ответить было бы нечем.
 */
export interface LinkCoursesResult {
  /**
   * Услуги, отмеченные курсовыми, но без цены в справочнике.
   *
   * По ним курсы не собираются вовсе: отличить продажу курса от оплаты одного
   * приёма нечем. Молчать об этом нельзя — раздел «Курсы» выглядел бы пустым
   * без причины.
   */
  priceless: string[];
  /** Курсов в базе после пересборки. */
  courses: number;
  /** Визитов, у которых привязка к курсу изменилась. */
  sessions: number;
  /** Сеансов, продажу которых в данных найти не удалось. */
  orphans: number;
}

/** Размер курса, если клиника его не указала. */
const DEFAULT_SESSIONS = 10;

/** Один ключ курса: пациент и день, когда приняли деньги. */
const courseKey = (patientId: string, purchasedAt: Date): string =>
  `${patientId}|${purchasedAt.getTime()}`;

export async function linkCourses(companyId: string): Promise<LinkCoursesResult> {
  const services = await prisma.service.findMany({
    where: { companyId, isCourse: true },
    select: { id: true, title: true, price: true, defaultSessions: true },
  });
  if (services.length === 0) return { courses: 0, sessions: 0, orphans: 0, priceless: [] };

  let courses = 0;
  let sessions = 0;
  let orphans = 0;
  const priceless: string[] = [];

  for (const service of services) {
    if (Number(service.price) <= 0) priceless.push(service.title);

    const [appts, existingCourses] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          companyId,
          deletedAt: null,
          // Отменённый визит курса не расходует: сеанс просто не состоялся.
          status: { not: "CANCELLED" },
          OR: [{ primaryServiceId: service.id }, { services: { some: { serviceId: service.id } } }],
        },
        select: {
          id: true,
          patientId: true,
          startAt: true,
          revenue: true,
          courseId: true,
          courseSessionIndex: true,
        },
        orderBy: { startAt: "asc" },
      }),
      prisma.course.findMany({
        where: { companyId, serviceId: service.id },
        select: {
          id: true,
          patientId: true,
          purchasedAt: true,
          sessionsTotal: true,
          sessionsUsed: true,
          amount: true,
          status: true,
        },
      }),
    ]);

    const apptById = new Map(appts.map((a) => [a.id, a]));
    const courseByKey = new Map(existingCourses.map((c) => [courseKey(c.patientId, c.purchasedAt), c]));
    const keep = new Set<string>();

    const byPatient = new Map<string, CourseVisit[]>();
    for (const a of appts) {
      const list = byPatient.get(a.patientId) ?? [];
      list.push({ id: a.id, startAt: a.startAt, revenue: Number(a.revenue) });
      byPatient.set(a.patientId, list);
    }

    /** Привязка, к которой визит должен прийти: null — никакой. */
    const wanted = new Map<string, { courseId: string | null; index: number | null }>();
    for (const a of appts) wanted.set(a.id, { courseId: null, index: null });

    for (const [patientId, visits] of byPatient) {
      const plan = buildCourses(visits, {
        // Цена сеанса — из прайса клиники: по ней отличаем продажу курса от
        // оплаты одного приёма. Размер курса — оттуда же, это её решение.
        sessionPrice: Number(service.price),
        sessionsTotal: service.defaultSessions ?? DEFAULT_SESSIONS,
      });
      orphans += plan.orphans.length;

      for (const c of plan.courses) {
        const key = courseKey(patientId, c.purchasedAt);
        const done = c.visitIds.length >= c.sessionsTotal;
        const data = {
          sessionsTotal: c.sessionsTotal,
          sessionsUsed: c.visitIds.length,
          amount: c.amount,
          pricePerSession: pricePerSession(c.amount, c.sessionsTotal),
          status: done ? ("COMPLETED" as const) : ("ACTIVE" as const),
          completedAt: done ? c.purchasedAt : null,
        };

        const existing = courseByKey.get(key);
        let courseId: string;
        if (existing) {
          courseId = existing.id;
          const same =
            existing.sessionsTotal === data.sessionsTotal &&
            existing.sessionsUsed === data.sessionsUsed &&
            Number(existing.amount) === data.amount &&
            existing.status === data.status;
          if (!same) await prisma.course.update({ where: { id: courseId }, data });
        } else {
          const row = await prisma.course.create({
            data: {
              companyId,
              patientId,
              serviceId: service.id,
              origin: "MANUAL",
              purchasedAt: c.purchasedAt,
              ...data,
            },
            select: { id: true },
          });
          courseId = row.id;
        }
        keep.add(courseId);
        courses += 1;

        // Номер сеанса — то, что администратор называет пациенту вслух.
        c.visitIds.forEach((id, i) => wanted.set(id, { courseId, index: i + 1 }));
      }
    }

    for (const [apptId, want] of wanted) {
      const cur = apptById.get(apptId);
      if (!cur) continue;
      if (cur.courseId === want.courseId && cur.courseSessionIndex === want.index) continue;
      await prisma.appointment.update({
        where: { id: apptId },
        data: { courseId: want.courseId, courseSessionIndex: want.index },
      });
      sessions += 1;
    }

    /**
     * Курсы, которых в новом разборе нет, убираем.
     *
     * Появляются, когда визит дня продажи перенесли или отменили: старая
     * карточка курса осталась бы висеть с датой, которой больше нет.
     */
    const stale = existingCourses.filter((c) => !keep.has(c.id)).map((c) => c.id);
    if (stale.length > 0) {
      await prisma.course.deleteMany({ where: { companyId, id: { in: stale } } });
    }
  }

  return { courses, sessions, orphans, priceless };
}
