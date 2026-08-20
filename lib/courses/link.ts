import { prisma } from "@/lib/db";
import { startOfClinicDay } from "@/lib/clinic-time";
import {
  assignSales,
  buildCourses,
  pricePerSession,
  recentSessionPrice,
  type CoursePlanOption,
  type CourseSale,
  type CourseVisit,
  type ServiceCandidate,
} from "./build";
import { coursePurchases, type RawTransaction } from "./purchases";
import { coursePriceByService } from "./product";

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
  /**
   * Курсовые услуги, у которых не было ни одного платного приёма.
   *
   * Цену сеанса пришлось взять из справочника, а там у одной услуги она стоит
   * за сеанс, у другой за весь курс. Плановая цена курса выходит наугад, и по
   * ней мы решаем, покупка это курса или оплата приёма. Молчать нельзя: курсы
   * по такой услуге либо не соберутся, либо соберутся не те.
   */
  guessedPrice: string[];
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

/**
 * Ключ курса: пациент, день покупки и сумма.
 *
 * Без суммы две покупки одного дня давали один ключ: второй курс не находил
 * себя в базе, создавался заново, а следующий круг считал лишним и удалял —
 * и так по кругу.
 *
 * Сумма, а не номер продажи: номер пришлось бы хранить в поле с уникальным
 * индексом, и переназначение продажи на другую услугу падало бы на нём. Две
 * покупки одного дня на одну и ту же сумму по одной услуге неразличимы и
 * так — ни по каким данным.
 */
const courseKey = (patientId: string, purchasedAt: Date, amount: number): string =>
  `${patientId}|${purchasedAt.getTime()}|${Math.round(amount)}`;

export async function linkCourses(
  companyId: string,
  /**
   * Кассовые операции за период. Курс продаётся не записью приёма, а покупкой
   * в кассе — без них курсы соберутся только у тех, кому оплату провели
   * записью, а таких меньшинство.
   */
  transactions: RawTransaction[] = [],
  /**
   * С какой даты прочитана касса.
   *
   * Пересобирать курсы можно только там, куда мы смотрели. Обычный круг берёт
   * последние двести дней, а разбор шёл по всей истории — у курсов постарше
   * покупки в этом прогоне не было, и они удалялись как лишние. Полный перечёт
   * их создавал, ближайший крон убивал: за полчаса из восьмидесяти трёх курсов
   * оставалось сорок шесть.
   *
   * Всё, что куплено раньше этой даты, не трогаем вовсе: там нечего сверять.
   */
  since: Date = new Date(0),
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
  const priceless: string[] = [];
  const guessedPrice: string[] = [];

  /**
   * Цена курса, объявленная клиникой в справочнике.
   *
   * Рядом с «БОС-терапия» за 2 800 ₽ там лежит «БОС-терапия, курс» за 28 000 ₽.
   * Клиника уже сказала, сколько стоит её курс, — считать это самим значит
   * спрашивать о том, на что ответ есть.
   */
  const catalogue = (
    await prisma.service.findMany({
      where: { companyId },
      select: {
        id: true,
        title: true,
        price: true,
        defaultSessions: true,
        _count: { select: { primaryForAppointments: true, appointmentServices: true } },
      },
    })
  ).map((sv) => ({
    id: sv.id,
    title: sv.title,
    price: Number(sv.price),
    sessions: sv.defaultSessions,
    visits: sv._count.primaryForAppointments + sv._count.appointmentServices,
  }));
  const declared = coursePriceByService(catalogue, DEFAULT_SESSIONS);
  const visitsOf = new Map(catalogue.map((sv) => [sv.id, sv.visits]));

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
    /**
     * Оплаты берём из состава визита, а не из основной услуги.
     *
     * У записи одна основная услуга, а услуг в ней бывает несколько. Услуга,
     * которая всегда идёт второй, по основной не находится вовсе — платформа
     * решала, что платных приёмов по ней не было, и цену сеанса брала из
     * справочника. Ровно это и случилось с «Нейромедитацией»: двадцать один
     * платный приём, а в предупреждении «платных приёмов не было».
     *
     * В составе визита у каждой услуги своя стоимость — это и есть цена
     * сеанса, причём точнее суммы всего визита.
     */
    const paid = await prisma.appointmentService.findMany({
      where: {
        companyId,
        serviceId: { in: services.map((sv) => sv.id) },
        priceCharged: { gt: 0 },
        appointment: { deletedAt: null, status: { not: "CANCELLED" } },
      },
      select: { serviceId: true, priceCharged: true },
      // От новых к старым: цена сеанса берётся по недавним оплатам.
      orderBy: { appointment: { startAt: "desc" } },
    });
    const amounts = new Map<string, number[]>();
    for (const a of paid) {
      amounts.set(a.serviceId, [...(amounts.get(a.serviceId) ?? []), Number(a.priceCharged)]);
    }
    for (const sv of services) {
      const observed = recentSessionPrice(amounts.get(sv.id) ?? []);
      /**
       * Платных приёмов не было — цена сеанса берётся из справочника, а там у
       * одной услуги она стоит за сеанс, у другой за весь курс. Молчать нельзя.
       *
       * Кроме случая, когда цену курса клиника объявила отдельной карточкой:
       * тогда оценка по цене сеанса не нужна вовсе.
       */
      if (observed <= 0 && Number(sv.price) > 0 && !declared.has(sv.id)) {
        guessedPrice.push(sv.title);
      }
      sessionPrices.set(sv.id, observed > 0 ? observed : Number(sv.price));
    }
  }
  if (services.length === 0) {
    return { courses: 0, sessions: 0, orphans: 0, priceless: [], guessedPrice: [], ambiguous: 0 };
  }

  let courses = 0;
  let sessions = 0;
  let orphans = 0;

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
        startAt: { gte: since },
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
    /**
     * Варианты курса услуги: объявленные клиникой важнее нашей оценки.
     *
     * Если карточки курса в справочнике нет, вариант один — цена сеанса,
     * умноженная на размер курса из карточки услуги.
     */
    const plansOf = (id: string): CoursePlanOption[] => {
      const fromDirectory = declared.get(id);
      if (fromDirectory && fromDirectory.length > 0) return fromDirectory;
      const price = (sessionPrices.get(id) ?? 0) * (sizeOf.get(id) ?? DEFAULT_SESSIONS);
      return price > 0 ? [{ price, sessions: sizeOf.get(id) ?? DEFAULT_SESSIONS }] : [];
    };
    for (const a of zero) {
      const ids = new Set(a.services.map((x) => x.serviceId));
      if (a.primaryServiceId) ids.add(a.primaryServiceId);
      for (const id of ids) {
        if (!courseIds.has(id)) continue;
        const perPatient = zeroVisits.get(a.patientId) ?? new Map<string, ServiceCandidate>();
        const found = perPatient.get(id);
        perPatient.set(id, {
          dates: [...(found?.dates ?? []), a.startAt],
          // Варианты курса: из справочника, иначе оценка по цене сеанса.
          plans: found?.plans ?? plansOf(id),
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

  /** Варианты курса услуги — те же, что видит раздача продаж. */
  const declaredPlans = (id: string): CoursePlanOption[] => {
    const fromDirectory = declared.get(id);
    if (fromDirectory && fromDirectory.length > 0) return fromDirectory;
    const size = services.find((sv) => sv.id === id)?.defaultSessions ?? DEFAULT_SESSIONS;
    const price = (sessionPrices.get(id) ?? 0) * size;
    return price > 0 ? [{ price, sessions: size }] : [];
  };

  for (const service of services) {
    /**
     * Карточка курса приёмов не знает.
     *
     * «БОС-терапия, курс» — это цена и размер курса, а ходят люди на
     * «БОС-терапия». Сеансов у такой карточки нет и быть не может, курсов по
     * ней не соберётся никогда — и предупреждать о её цене не о чем.
     */
    if ((visitsOf.get(service.id) ?? 0) === 0) continue;

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
          // Только окно, по которому прочитана касса: см. параметр since.
          startAt: { gte: since },
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
        where: { companyId, serviceId: service.id, purchasedAt: { gte: since } },
        select: {
          id: true,
          patientId: true,
          purchasedAt: true,
          origin: true,
          sessionsTotal: true,
          sessionsUsed: true,
          amount: true,
          status: true,
        },
      }),
    ]);

    const apptById = new Map(appts.map((a) => [a.id, a]));
    /** Курсы вне окна: их связи трогать нельзя. */
    const outOfScope = new Set(
      (
        await prisma.course.findMany({
          where: { companyId, serviceId: service.id, purchasedAt: { lt: since } },
          select: { id: true },
        })
      ).map((c) => c.id),
    );
    const courseByKey = new Map(
      existingCourses.map((c) => [courseKey(c.patientId, c.purchasedAt, Number(c.amount)), c]),
    );
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
        /**
         * Плановая цена курса: цена сеанса × число сеансов из карточки услуги.
         * Цена сеанса — из записей клиники, а не из справочника: там у одной
         * услуги цена стоит за сеанс, у другой за весь курс.
         */
        plans: declaredPlans(service.id),
        sales: salesFor.get(patientId)?.get(service.id) ?? [],
      });
      orphans += plan.orphans.length;

      for (const c of plan.courses) {
        const key = courseKey(patientId, c.purchasedAt, c.amount);
        const done = c.visitIds.length >= c.sessionsTotal;
        const data = {
          sessionsTotal: c.sessionsTotal,
          sessionsUsed: c.visitIds.length,
          amount: c.amount,
          pricePerSession: pricePerSession(c.amount, c.sessionsTotal),
          status: done ? ("COMPLETED" as const) : ("ACTIVE" as const),
          completedAt: done ? c.purchasedAt : null,
          /**
           * Откуда деньги: касса или запись приёма.
           *
           * От этого зависит, добавлять ли сумму курса к выручке дня. Продажа
           * в кассе в выручке визитов не лежит — её добавляют. Оплата в записи
           * там уже есть, и добавить её второй раз значит удвоить те же рубли.
           */
          origin: c.fromSale ? ("YCLIENTS" as const) : ("MANUAL" as const),
        };

        const existing = courseByKey.get(key);
        let courseId: string;
        if (existing) {
          courseId = existing.id;
          const same =
            existing.sessionsTotal === data.sessionsTotal &&
            existing.sessionsUsed === data.sessionsUsed &&
            Number(existing.amount) === data.amount &&
            existing.origin === data.origin &&
            existing.status === data.status;
          if (!same) await prisma.course.update({ where: { id: courseId }, data });
        } else {
          const row = await prisma.course.create({
            data: {
              companyId,
              patientId,
              serviceId: service.id,
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
        startAt: { gte: since },
        // Курс куплен раньше окна — он вне пересборки, и связь его сеансов не
        // наша забота: удалять её значило бы стирать то, чего мы не проверяли.
        course: { purchasedAt: { gte: since } },
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
      /**
       * Сеанс уже привязан к курсу, купленному раньше окна.
       *
       * Такой курс мы в этом прогоне не пересобирали — покупки за той датой не
       * читали. Снять связь значило бы стереть работу полного перечёта, а
       * поставить свою — приписать сеанс не тому курсу.
       */
      if (want.courseId === null && cur.courseId !== null && outOfScope.has(cur.courseId)) {
        continue;
      }
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

  return { courses, sessions, orphans, priceless, guessedPrice, ambiguous };
}
