/**
 * Курс, собранный из записей YCLIENTS.
 *
 * Клиника продаёт БОС-терапию и IV-терапию курсами: пациент платит за десять
 * сеансов сразу, а ходит месяц. В YCLIENTS это выглядит так, что деньги стоят
 * в записи дня продажи, а у остальных сеансов стоимость нулевая — они уже
 * оплачены.
 *
 * Отдельной сущности «курс» YCLIENTS нам не отдаёт, поэтому собираем её из
 * самих записей. Никаких новых денег при этом не появляется: сумма курса —
 * это та самая стоимость из записи дня продажи, которая и так учтена в
 * выручке того дня. Курс нужен, чтобы объяснить остальные нули: «сеанс 4 из
 * 10 по курсу от 3 августа» вместо голого «0 ₽», из-за которого разрез по
 * услугам выглядел так, будто процедуру никто не делает.
 */

export interface CourseVisit {
  id: string;
  startAt: Date;
  /** Деньги, принятые в этот день по курсовой услуге. */
  revenue: number;
}

export interface PlannedCourse {
  /** День, когда приняли деньги. */
  purchasedAt: Date;
  amount: number;
  sessionsTotal: number;
  /** Визиты курса по порядку; первый — день продажи. */
  visitIds: string[];
}

export interface CoursePlan {
  courses: PlannedCourse[];
  /**
   * Сеансы, у которых продажи в данных нет.
   *
   * Курс купили до того, как мы выгрузили историю, либо оплату провели не
   * записью. Приписывать такой сеанс к ближайшему курсу нельзя: получится
   * курс из пятнадцати сеансов там, где их десять.
   */
  orphans: string[];
}

/**
 * Разложить визиты пациента по одной курсовой услуге на курсы.
 *
 * Визиты должны идти по возрастанию времени. Оплаченный визит открывает курс,
 * следующие бесплатные к нему прикрепляются, пока не наберётся заявленное
 * число сеансов. Новая оплата всегда открывает новый курс — даже если в
 * прошлом сеансы остались: клиника продала ещё один, а не доплатила за старый.
 */
export function buildCourses(visits: CourseVisit[], sessionsTotal: number): CoursePlan {
  const total = Math.max(1, sessionsTotal);
  const courses: PlannedCourse[] = [];
  const orphans: string[] = [];
  let open: PlannedCourse | null = null;

  for (const v of [...visits].sort((a, b) => a.startAt.getTime() - b.startAt.getTime())) {
    if (v.revenue > 0) {
      open = { purchasedAt: v.startAt, amount: v.revenue, sessionsTotal: total, visitIds: [v.id] };
      courses.push(open);
      continue;
    }
    if (open && open.visitIds.length < total) {
      open.visitIds.push(v.id);
      continue;
    }
    // Сеансов набралось больше проданного — курс закрыт, а этот сеанс из
    // какого-то другого. Гадать не будем.
    orphans.push(v.id);
  }

  return { courses, orphans };
}

/**
 * Цена одного сеанса.
 *
 * Материализуется вместе с курсом: при неровном делении остаток закрепляется
 * за последним сеансом, иначе сумма сеансов не сойдётся с ценой курса.
 */
export function pricePerSession(amount: number, sessionsTotal: number): number {
  const n = Math.max(1, sessionsTotal);
  return Math.round((amount / n) * 100) / 100;
}
