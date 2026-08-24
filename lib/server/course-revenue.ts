import { prisma } from "@/lib/db";

/**
 * Продажи курсов как деньги дня.
 *
 * Требование заказчика с самого начала: «продали курс БОС за 28 тысяч — добавить
 * в дневной отчёт, а остальные дни отмечать как курс». Долгое время платформа
 * этого не делала — не потому что так решили, а потому что покупку было
 * негде взять: в записях приёмов её нет, курс пробивают кассовой операцией.
 *
 * Теперь покупка известна, и день продажи получает свои деньги. Двойного счёта
 * не будет: сеанс курса даёт ноль (стоимость в его записи нулевая), а продажа,
 * проведённая записью приёма, в кассовые покупки не попадает — такие операции
 * привязаны к записи и отбрасываются при разборе кассы.
 *
 * Считаем по подтверждённым курсам: покупка, которую не удалось отнести ни к
 * одной услуге, курса не образует и в выручку не идёт. Таких единицы, и их
 * число выгрузка называет отдельно — лучше недосчитать, чем приписать клинике
 * деньги, про которые мы не поняли, за что они.
 *
 * И только те курсы, что открыты покупкой в кассе (origin YCLIENTS). Курс
 * иногда проводят оплатой в самой записи приёма — такие деньги уже посчитаны
 * выручкой того визита, и добавить их сюда значит удвоить одни и те же рубли.
 */

/**
 * Покупки, которые считаются выручкой.
 *
 * Похожие на курс по сумме — товар и разовая оплата в выручку курсов не идут.
 * Оплата курса записью приёма сюда не попадает вовсе: у неё нет кассовой
 * операции, её деньги уже в стоимости визита.
 */
const COUNTED = { isCourse: true } as const;
export interface CoursePurchaseRow {
  id: string;
  /** Момент покупки. */
  at: Date;
  amount: number;
  serviceTitle: string;
  sessionsTotal: number;
  patientName: string | null;
  /**
   * Кто ведёт сеансы этого курса.
   *
   * У кассовой операции специалиста нет — есть клиент и сумма. Но сеансы курса
   * ведёт один человек, и деньги за курс принадлежат ему: без этого
   * БОС-терапевт с полусотней сеансов выглядела бы бесполезной.
   */
  staffName: string | null;
  /** Он же идентификатором: по имени не различить тёзок. */
  staffId: string | null;
}

/** Кто чаще других встречается в списке. Пусто — если список пуст. */
function dominant(ids: string[]): string | null {
  if (ids.length === 0) return null;
  const count = new Map<string, number>();
  for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export async function coursePurchasesBetween(
  companyId: string,
  from: Date,
  to: Date,
): Promise<CoursePurchaseRow[]> {
  const rows = await prisma.coursePurchase.findMany({
    where: { companyId, ...COUNTED, purchasedAt: { gte: from, lt: to } },
    orderBy: { purchasedAt: "asc" },
    select: {
      id: true,
      patientId: true,
      purchasedAt: true,
      amount: true,
      serviceId: true,
      patient: { select: { name: true } },
      // Услуга, опознанная по сумме, — на случай, когда курс ещё не собрался.
      service: { select: { title: true, defaultSessions: true } },
      course: {
        select: {
          serviceId: true,
          sessionsTotal: true,
          service: { select: { title: true } },
          appointments: { select: { staffId: true, staff: { select: { name: true } } } },
        },
      },
    },
  });

  const out: CoursePurchaseRow[] = [];
  /** Покупки без специалиста — им ответим отдельным проходом, все разом. */
  const orphans: { row: CoursePurchaseRow; serviceId: string; patientId: string }[] = [];

  for (const r of rows) {
    /**
     * Услугу знаем и до того, как соберётся курс: её опознали по сумме при
     * сохранении покупки. Специалиста называют сеансы курса.
     */
    const visits = r.course?.appointments ?? [];
    const staffId = dominant(visits.map((a) => a.staffId).filter((x): x is string => Boolean(x)));
    const row: CoursePurchaseRow = {
      id: r.id,
      at: r.purchasedAt,
      amount: Number(r.amount),
      serviceTitle:
        r.course?.service.title ?? r.service?.title ?? "Курс (услуга не определена)",
      sessionsTotal: r.course?.sessionsTotal ?? r.service?.defaultSessions ?? 0,
      patientName: r.patient.name,
      staffName: visits.find((a) => a.staffId === staffId)?.staff?.name ?? null,
      staffId,
    };
    out.push(row);

    const serviceId = r.course?.serviceId ?? r.serviceId;
    if (!staffId && serviceId) orphans.push({ row, serviceId, patientId: r.patientId });
  }

  await attachStaffToOrphans(companyId, orphans);
  return out;
}

/**
 * Курс куплен, а сеансов ещё нет — кому эти деньги?
 *
 * Пока ответа не было, деньги не доставались никому: в разрезе по услугам
 * БОС-терапия показывала 218 000 ₽, а у специалиста, которая её и ведёт,
 * стояло 180 000 ₽. Сумма строк не сходилась с итогом, и объяснить это на
 * экране было нечем.
 *
 * Отвечаем по порядку, ничего не выдумывая:
 *
 *  1. Сеансы самого курса — если они есть (это сделано выше).
 *  2. Визиты ЭТОГО пациента по ЭТОЙ услуге: курс продлевают, и водит пациента
 *     тот же человек. То же правило, только шире одного курса.
 *  3. Единственный специалист услуги в клинике: если БОС-терапию ведёт один
 *     человек, вопроса «кто из них» не существует.
 *
 * Услугу ведут двое, курса нет и истории у пациента нет — оставляем пусто.
 * Такие деньги показываются на экране отдельной строкой: приписать их наугад
 * значит соврать про конкретного человека, а промолчать — про итог.
 */
async function attachStaffToOrphans(
  companyId: string,
  orphans: { row: CoursePurchaseRow; serviceId: string; patientId: string }[],
): Promise<void> {
  if (orphans.length === 0) return;

  const serviceIds = [...new Set(orphans.map((o) => o.serviceId))];
  const patientIds = [...new Set(orphans.map((o) => o.patientId))];
  const ofService = (ids: string[]) => [
    { services: { some: { serviceId: { in: ids } } } },
    { primaryServiceId: { in: ids } },
  ];

  /**
   * Два запроса вместо одного, и оба узкие.
   *
   * Сначала здесь читались все визиты этих услуг за всю историю — сотни строк
   * на каждую загрузку экрана владельца ради одной-двух покупок. Правило 2
   * спрашивает только про самих покупателей, правило 3 — только про список
   * специалистов, и его считает база, а не мы.
   *
   * Отменённые визиты не в счёт: отменённый приём никого специалистом курса не
   * делает. Услугу визита ищем и в составе, и в основной — у части старых
   * записей состав так и не был записан.
   */
  const own = await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      status: { not: "CANCELLED" },
      patientId: { in: patientIds },
      OR: ofService(serviceIds),
    },
    select: {
      patientId: true,
      staffId: true,
      primaryServiceId: true,
      staff: { select: { name: true } },
      services: { select: { serviceId: true } },
    },
  });

  const byPatient = new Map<string, string[]>();
  const nameOf = new Map<string, string>();
  const wanted = new Set(serviceIds);
  for (const v of own) {
    if (!v.staffId || !v.patientId) continue;
    if (v.staff?.name) nameOf.set(v.staffId, v.staff.name);
    const ids = new Set(v.services.map((x) => x.serviceId));
    if (v.primaryServiceId) ids.add(v.primaryServiceId);
    for (const serviceId of ids) {
      if (!wanted.has(serviceId)) continue;
      const key = `${v.patientId}:${serviceId}`;
      byPatient.set(key, [...(byPatient.get(key) ?? []), v.staffId]);
    }
  }

  /**
   * Кто вообще ведёт услугу — по одной услуге за раз, группировкой в базе.
   *
   * Спрашиваем только про те услуги, на которые правило 2 не ответило: обычно
   * таких нет вовсе, и второй запрос не выполняется ни разу.
   */
  const unresolved = [
    ...new Set(
      orphans
        .filter((o) => !dominant(byPatient.get(`${o.patientId}:${o.serviceId}`) ?? []))
        .map((o) => o.serviceId),
    ),
  ];
  const soleStaff = new Map<string, string | null>();
  for (const serviceId of unresolved) {
    const groups = await prisma.appointment.groupBy({
      by: ["staffId"],
      where: {
        companyId,
        deletedAt: null,
        status: { not: "CANCELLED" },
        OR: ofService([serviceId]),
      },
    });
    const ids = groups.map((g) => g.staffId).filter((x): x is string => Boolean(x));
    // Единственный специалист услуги — не догадка, а единственный ответ.
    soleStaff.set(serviceId, ids.length === 1 ? ids[0] : null);
  }

  const missingNames = [...soleStaff.values()].filter(
    (id): id is string => Boolean(id) && !nameOf.has(id!),
  );
  if (missingNames.length > 0) {
    for (const st of await prisma.staff.findMany({
      where: { id: { in: missingNames } },
      select: { id: true, name: true },
    })) {
      nameOf.set(st.id, st.name);
    }
  }

  for (const { row, serviceId, patientId } of orphans) {
    const mine = dominant(byPatient.get(`${patientId}:${serviceId}`) ?? []);
    const staffId = mine ?? soleStaff.get(serviceId) ?? null;
    if (!staffId) continue;
    row.staffId = staffId;
    row.staffName = nameOf.get(staffId) ?? null;
  }
}

/** Сумма проданных курсов за период. */
export async function coursesSoldBetween(
  companyId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const agg = await prisma.coursePurchase.aggregate({
    where: { companyId, ...COUNTED, purchasedAt: { gte: from, lt: to } },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount ?? 0);
}
