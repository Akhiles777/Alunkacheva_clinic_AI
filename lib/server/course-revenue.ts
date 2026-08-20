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
 */
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
  const rows = await prisma.course.findMany({
    where: { companyId, purchasedAt: { gte: from, lt: to } },
    orderBy: { purchasedAt: "asc" },
    select: {
      id: true,
      purchasedAt: true,
      amount: true,
      sessionsTotal: true,
      service: { select: { title: true } },
      patient: { select: { name: true } },
      appointments: { select: { staffId: true, staff: { select: { name: true } } } },
    },
  });
  return rows.map((r) => {
    // Специалист курса — тот, кто провёл больше всего его сеансов.
    const ids = r.appointments.map((a) => a.staffId).filter((x): x is string => Boolean(x));
    const staffId =
      ids.sort((a, b) => ids.filter((x) => x === b).length - ids.filter((x) => x === a).length)[0] ?? null;
    const staffName = r.appointments.find((a) => a.staffId === staffId)?.staff?.name ?? null;
    return {
      id: r.id,
      at: r.purchasedAt,
      amount: Number(r.amount),
      serviceTitle: r.service.title,
      sessionsTotal: r.sessionsTotal,
      patientName: r.patient.name,
      staffName,
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
  const agg = await prisma.course.aggregate({
    where: { companyId, purchasedAt: { gte: from, lt: to } },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount ?? 0);
}
