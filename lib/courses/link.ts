import { prisma } from "@/lib/db";
import { startOfClinicDay } from "@/lib/clinic-time";
import {
  assignSales,
  buildCourses,
  pricePerSession,
  recentSessionPrice,
  type CourseSale,
  type CourseVisit,
  type ServiceCandidate,
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
   * Услуги, отмеченные курсовыми, но без цены сеанса.
   *
   * Ни одного платного приёма в записях и пусто в справочнике — отличить
   * продажу курса от оплаты одного приёма нечем, и курсы по такой услуге не
   * собираются. Молчать об этом нельзя: раздел «Курсы» выглядел бы пустым без
   * причины.
   */
  priceless: string[];
  /** Курсов в базе после пересборки. */
  courses: number;
  /** Визитов, у которых привязка к курсу изменилась. */
  sessions: number;
  /** Сеансов, продажу которых в данных найти не удалось. */
  orphans: number;
  /**
   * Продажи, которые нельзя отнести к одной услуге.
   *
   * После покупки у пациента сеансы двух курсовых услуг сразу, и за какую из
   * них заплатили — из кассовой операции не видно. Курс по такой продаже не
   * создаём: догадка о деньгах клиента не должна выглядеть фактом.
   */
  ambiguous: number;
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
      /**
       * День покупки, а не её минута.
       *
       * Клиника берёт деньги, когда человек уже в кабинете: пациент прошёл
       * сеанс в 10:40, а курс оплатил в 12:51 того же дня. При сравнении по
       * минуте этот сеанс оказывался раньше покупки и оставался без курса —
       * в истории он выглядел как «по курсу» без номера между двумя
       * пронумерованными. Покупка забирает свой день целиком.
       */
      list.push({
        id: `${p.saleId ?? p.at.getTime()}`,
        at: startOfClinicDay(p.at),
        amount: p.amount,
      });
      salesByPatient.set(patientId, list);
    }
  }

  const services = await prisma.service.findMany({
    where: { companyId, isCourse: true },
    select: { id: true, title: true, price: true, defaultSessions: true },
  });

  /**
   * Цена одного сеанса — из того, что клиника реально брала за одиночный приём.
   *
   * В справочнике полагаться на цену нельзя: у «БОС-терапия» там стоит 2 800 ₽
   * за сеанс, а у «БОС-терапия, курс» — 28 000 ₽ за весь курс. Одно поле, два
   * разных смысла, и различить их можно только по записям.
   *
   * Медиана, а не среднее: среди оплат этой услуги попадаются и продажи курса
   * записью (25 000 ₽), среднее они бы утащили в потолок.
   */
  const sessionPrices = new Map<string, number>();
  if (services.length > 0) {
    const paid = await prisma.appointment.findMany({
      where: {
        companyId,
        deletedAt: null,
        status: { not: "CANCELLED" },
        revenue: { gt: 0 },
        primaryServiceId: { in: services.map((sv) => sv.id) },
      },
      select: { primaryServiceId: true, revenue: true },
      // От новых к старым: цена сеанса берётся по недавним оплатам.
      orderBy: { startAt: "desc" },
    });
    const amounts = new Map<string, number[]>();
    for (const a of paid) {
      const id = a.primaryServiceId;
      if (!id) continue;
      amounts.set(id, [...(amounts.get(id) ?? []), Number(a.revenue)]);
    }
    for (const sv of services) {
      const observed = recentSessionPrice(amounts.get(sv.id) ?? []);
      // Приёмов ещё не было — остаётся справочник, другого источника нет.
      sessionPrices.set(sv.id, observed > 0 ? observed : Number(sv.price));
    }
  }
  if (services.length === 0) {
    return { courses: 0, sessions: 0, orphans: 0, priceless: [], ambiguous: 0 };
  }

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
  const zeroVisits = new Map<string, Map<string, ServiceCandidate>>();
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
    const sizeOf = new Map(services.map((sv) => [sv.id, sv.defaultSessions ?? DEFAULT_SESSIONS]));
    const planPriceOf = (id: string): number =>
      (sessionPrices.get(id) ?? 0) * (sizeOf.get(id) ?? DEFAULT_SESSIONS);
    for (const a of zero) {
      const ids = new Set(a.services.map((x) => x.serviceId));
      if (a.primaryServiceId) ids.add(a.primaryServiceId);
      for (const id of ids) {
        if (!courseIds.has(id)) continue;
        const perPatient = zeroVisits.get(a.patientId) ?? new Map<string, ServiceCandidate>();
        const found = perPatient.get(id);
        perPatient.set(id, {
          dates: [...(found?.dates ?? []), a.startAt],
          // Плановая цена курса: цена сеанса × число сеансов из карточки услуги.
          planPrice: found?.planPrice ?? planPriceOf(id),
        });
        zeroVisits.set(a.patientId, perPatient);
      }
    }
  }

  /** Продажи, розданные по услугам: пациент → услуга → покупки. */
  const salesFor = new Map<string, Map<string, CourseSale[]>>();
  /**
   * Продажи, у которых кандидатов больше одного.
   *
   * Курс по ним не создаётся: приписать деньги наугад к одной из двух услуг
   * значит показать владельцу догадку под видом факта. Считаем их и называем.
   */
  let ambiguous = 0;
  for (const [patientId, sales] of salesByPatient) {
    const assigned = assignSales(sales, zeroVisits.get(patientId) ?? new Map());
    salesFor.set(patientId, assigned.byService);
    ambiguous += assigned.ambiguous.length;
  }

  for (const service of services) {
    const sessionPrice = sessionPrices.get(service.id) ?? 0;
    if (sessionPrice <= 0) priceless.push(service.title);

    const [appts, existingCourses] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          companyId,
          deletedAt: null,
          /**
           * Сеанс считается израсходованным, только если он состоялся или ещё
           * предстоит. Отменённый и неявка курса не расходуют: услуга не
           * оказана. Иначе курс из десяти сеансов заканчивался бы на восьмом,
           * а последние настоящие сеансы оставались без номера.
           */
          status: { in: ["CREATED", "CONFIRMED", "ARRIVED"] },
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
        // Цена сеанса — из записей клиники, а не из справочника: там у одной
        // услуги цена за сеанс, у другой за весь курс.
        sessionPrice,
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

    /**
     * Снимаем привязку с того, что выпало из курса.
     *
     * Визит могли отменить или отметить неявкой уже после того, как он попал в
     * курс. В разбор он больше не входит, а `courseId` у него остаётся — и в
     * карточке отменённый приём показывался как «курс 3 из 10». Чистим отдельно:
     * в общий проход такие визиты не попадают по определению.
     */
    const strayLinks = await prisma.appointment.findMany({
      where: {
        companyId,
        courseId: { not: null },
        OR: [{ primaryServiceId: service.id }, { services: { some: { serviceId: service.id } } }],
        NOT: { id: { in: [...wanted.keys()] } },
      },
      select: { id: true },
    });
    if (strayLinks.length > 0) {
      await prisma.appointment.updateMany({
        where: { id: { in: strayLinks.map((x) => x.id) } },
        data: { courseId: null, courseSessionIndex: null },
      });
      sessions += strayLinks.length;
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

  return { courses, sessions, orphans, priceless, ambiguous };
}
