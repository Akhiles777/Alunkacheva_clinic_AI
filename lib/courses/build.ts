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
   * записью — в YCLIENTS для этого есть абонементы, а их мы пока не читаем.
   * Приписывать такой сеанс к ближайшему курсу нельзя: получится курс из
   * пятнадцати сеансов там, где их десять.
   */
  orphans: string[];
}

/**
 * Похожа ли оплата на продажу курса.
 *
 * Здесь и была ошибка, из-за которой на экране появились «БОС-терапия 1/2».
 * Курс открывала ЛЮБАЯ оплата, и десятки платежей по цене одного сеанса
 * превращались в десятки крошечных «курсов».
 *
 * Отличаем по деньгам: заплатили за один сеанс — это платный приём; заплатили
 * заметно больше — это курс. Порог в полторы цены сеанса, а не в две: курс
 * почти всегда идёт со скидкой, и требовать ровно двух цен значит пропустить
 * настоящие продажи.
 *
 * А вот СКОЛЬКО в курсе сеансов, из суммы не выводится. У клиники курс БОС —
 * десять сеансов, сеанс стоит 2 800 ₽, а платят за курс 25 000 ₽ со скидкой:
 * деление дало бы девять. Размер курса называет клиника в «Настройки →
 * Услуги», это факт, а не результат округления.
 */
export function looksLikeCourseSale(amount: number, sessionPrice: number): boolean {
  if (sessionPrice <= 0 || amount <= 0) return false;
  return amount >= sessionPrice * 1.5;
}

/** Продажа курса, найденная в кассе: день и сумма. */
export interface CourseSale {
  id: string;
  at: Date;
  amount: number;
}

export interface BuildCoursesOptions {
  /**
   * Цена одного сеанса по прайсу клиники. Без неё отличить продажу курса от
   * оплаты приёма нечем, и курсы не собираются вовсе — это честнее, чем
   * собрать их неправильно.
   */
  sessionPrice: number;
  /** Размер курса из справочника клиники: сколько сеансов в нём продаётся. */
  sessionsTotal: number;
  /**
   * Продажи курсов этого пациента из кассы.
   *
   * Главный источник: курс не продаётся записью приёма, он пробивается
   * кассовой операцией. Оплата в записи остаётся запасным вариантом — она
   * встречается, но реже.
   */
  sales?: CourseSale[];
}

/**
 * Сколько дней после продажи сеанс ещё считается сеансом этого курса.
 *
 * Без ограничения покупка годичной давности подобрала бы сеансы, к ней не
 * относящиеся: человек прошёл курс, через год пришёл снова, а платформа
 * приписала бы новые сеансы старой продаже.
 */
const SALE_WINDOW_DAYS = 180;

/**
 * Разложить визиты пациента по одной курсовой услуге на курсы.
 *
 * Визиты должны идти по возрастанию времени. Продажа курса открывает курс,
 * следующие бесплатные сеансы к нему прикрепляются, пока не наберётся
 * заявленное число. Новая продажа всегда открывает новый курс.
 *
 * Оплата одного сеанса курс не открывает и не закрывает: это платный приём
 * внутри той же услуги, и к курсу он отношения не имеет.
 */
export function buildCourses(visits: CourseVisit[], opts: BuildCoursesOptions): CoursePlan {
  const { sessionPrice } = opts;
  const total = Math.max(1, opts.sessionsTotal);
  const courses: PlannedCourse[] = [];
  const orphans: string[] = [];
  let open: PlannedCourse | null = null;

  /** Продажи по возрастанию времени; каждая открывает курс не больше раза. */
  const sales = [...(opts.sales ?? [])]
    .filter((s) => looksLikeCourseSale(s.amount, sessionPrice))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const usedSale = new Set<string>();
  const windowMs = SALE_WINDOW_DAYS * 24 * 3600 * 1000;

  /** Последняя продажа, случившаяся не позже сеанса и ещё не открытая. */
  const saleFor = (at: Date): CourseSale | null => {
    let best: CourseSale | null = null;
    for (const s of sales) {
      if (usedSale.has(s.id)) continue;
      if (s.at.getTime() > at.getTime()) break;
      if (at.getTime() - s.at.getTime() > windowMs) continue;
      best = s;
    }
    return best;
  };

  for (const v of [...visits].sort((a, b) => a.startAt.getTime() - b.startAt.getTime())) {
    if (v.revenue > 0) {
      // Оплата в записи — запасной путь: так курс тоже иногда проводят.
      if (!looksLikeCourseSale(v.revenue, sessionPrice)) continue;
      open = { purchasedAt: v.startAt, amount: v.revenue, sessionsTotal: total, visitIds: [v.id] };
      courses.push(open);
      continue;
    }

    // Открытый курс кончился либо его не было — ищем продажу в кассе.
    if (!open || open.visitIds.length >= open.sessionsTotal) {
      const sale = saleFor(v.startAt);
      if (sale) {
        usedSale.add(sale.id);
        open = { purchasedAt: sale.at, amount: sale.amount, sessionsTotal: total, visitIds: [] };
        courses.push(open);
      }
    }

    if (open && open.visitIds.length < open.sessionsTotal) {
      open.visitIds.push(v.id);
      continue;
    }
    // Сеансов набралось больше проданного, а новой продажи нет: этот сеанс из
    // курса, купленного до выгрузки. Гадать не будем.
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
