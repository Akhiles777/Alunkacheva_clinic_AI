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
      purchasedAt: true,
      amount: true,
      patient: { select: { name: true } },
      course: {
        select: {
          sessionsTotal: true,
          service: { select: { title: true } },
          appointments: { select: { staffId: true, staff: { select: { name: true } } } },
        },
      },
    },
  });
  return rows.map((r) => {
    /**
     * Услуга и специалист известны, только когда покупка собралась в курс —
     * то есть когда пациент начал ходить. До этого деньги есть, а чьи они —
     * ещё неизвестно, и выдумывать нечего.
     */
    const visits = r.course?.appointments ?? [];
    const ids = visits.map((a) => a.staffId).filter((x): x is string => Boolean(x));
    const staffId =
      ids.sort((a, b) => ids.filter((x) => x === b).length - ids.filter((x) => x === a).length)[0] ?? null;
    return {
      id: r.id,
      at: r.purchasedAt,
      amount: Number(r.amount),
      serviceTitle: r.course?.service.title ?? "Курс (услуга не определена)",
      sessionsTotal: r.course?.sessionsTotal ?? 0,
      patientName: r.patient.name,
      staffName: visits.find((a) => a.staffId === staffId)?.staff?.name ?? null,
      staffId,
    };
  });
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
