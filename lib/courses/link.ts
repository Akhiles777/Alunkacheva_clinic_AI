import { prisma } from "@/lib/db";
import {
  assignSales,
  buildCourses,
  pricePerSession,
  type CourseSale,
  type CourseVisit,
} from "./build";
import { coursePurchases, type RawTransaction } from "./purchases";

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

export async function linkCourses(
  companyId: string,
  /**
   * Кассовые операции за период. Курс продаётся не записью приёма, а покупкой
   * в кассе — без них курсы соберутся только у тех, кому оплату провели
   * записью, а таких меньшинство.
   */
  transactions: RawTransaction[] = [],
): Promise<LinkCoursesResult> {
  /**
   * Продажи по пациентам. Клиента находим по идентификатору YCLIENTS: он есть
   * и у операции, и у карточки.
   */
  const purchases = coursePurchases(transactions);
  const salesByPatient = new Map<string, CourseSale[]>();
  if (purchases.length > 0) {
    const patients = await prisma.patient.findMany({
      where: { companyId, yclientsId: { in: [...new Set(purchases.map((p) => p.clientId))] } },
      select: { id: true, yclientsId: true },
    });
    const byYclients = new Map(patients.map((p) => [p.yclientsId as number, p.id]));
    for (const p of purchases) {
      const patientId = byYclients.get(p.clientId);
      if (!patientId) continue;
      const list = salesByPatient.get(patientId) ?? [];
      list.push({ id: `${p.saleId ?? p.at.getTime()}`, at: p.at, amount: p.amount });
      salesByPatient.set(patientId, list);
    }
  }

  const services = await prisma.service.findMany({
    where: { companyId, isCourse: true },
    select: { id: true, title: true, price: true, defaultSessions: true },
  });
  if (services.length === 0) return { courses: 0, sessions: 0, orphans: 0, priceless: [] };

  let courses = 0;
  let sessions = 0;
  let orphans = 0;
  const priceless: string[] = [];

  /**
   * Бесплатные сеансы пациента по каждой курсовой услуге — чтобы решить, какой
   * из них принадлежит покупка. Одна операция в кассе не говорит, за какую
   * услугу заплатили, и пока каждая услуга разбирала продажи сама, одна
   * покупка открывала курс и по БОС, и по НАК.
   */
  const zeroVisits = new Map<string, Map<string, Date[]>>();
  if (salesByPatient.size > 0) {
    const zero = await prisma.appointment.findMany({
      where: {
        companyId,
        deletedAt: null,
        status: { not: "CANCELLED" },
        // Только сеансы, оплаченные не сегодня: подарки к курсу не относятся.
        revenueSource: "PREPAID",
        patientId: { in: [...salesByPatient.keys()] },
        OR: [
          { primaryServiceId: { in: services.map((sv) => sv.id) } },
          { services: { some: { serviceId: { in: services.map((sv) => sv.id) } } } },
        ],
      },
      select: {
        patientId: true,
        startAt: true,
        primaryServiceId: true,
        services: { select: { serviceId: true } },
      },
      orderBy: { startAt: "asc" },
    });
    const courseIds = new Set(services.map((sv) => sv.id));
    for (const a of zero) {
      const ids = new Set(a.services.map((x) => x.serviceId));
      if (a.primaryServiceId) ids.add(a.primaryServiceId);
      for (const id of ids) {
        if (!courseIds.has(id)) continue;
        const perPatient = zeroVisits.get(a.patientId) ?? new Map<string, Date[]>();
        perPatient.set(id, [...(perPatient.get(id) ?? []), a.startAt]);
        zeroVisits.set(a.patientId, perPatient);
      }
    }
  }

  /** Продажи, розданные по услугам: пациент → услуга → покупки. */
  const salesFor = new Map<string, Map<string, CourseSale[]>>();
  for (const [patientId, sales] of salesByPatient) {
    salesFor.set(patientId, assignSales(sales, zeroVisits.get(patientId) ?? new Map()));
  }

  for (const service of services) {
    if (Number(service.price) <= 0) priceless.push(service.title);

    const [appts, existingCourses] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          companyId,
          deletedAt: null,
          // Отменённый визит курса не расходует: сеанс просто не состоялся.
          status: { not: "CANCELLED" },
          /**
           * Подарок по стопроцентной скидке место в курсе не занимает: за него
           * не платили ни сегодня, ни при продаже. Иначе курс из десяти
           * сеансов заканчивался бы на восьмом.
           */
          revenueSource: { not: "FREE" },
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
        sales: salesFor.get(patientId)?.get(service.id) ?? [],
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
