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

/**
 * Какой услуге принадлежит продажа.
 *
 * Покупка в кассе не говорит, за какую услугу заплатили: у операции есть
 * клиент, сумма и номер продажи — и всё.
 *
 * Сначала здесь стояла догадка: отдавали услуге, к которой пациент пришёл
 * первым делом после покупки. Она угадывает в большинстве случаев, но именно
 * «угадывает», а догадка о деньгах клиента не должна выглядеть фактом.
 *
 * Потом было строгое «привязываем, только если кандидат один». Честно — и
 * бесполезно: пациент, купивший курс БОС и курс НАК, не получал ни одного,
 * хотя купил оба.
 *
 * Теперь спрашиваем у самой суммы. Курс из десяти сеансов по 2 800 ₽ стоит
 * около 28 000 ₽ — и покупка на 28 000 ₽ ни при каких условиях не курс НАК по
 * 1 000 ₽ за сеанс. Цена сеанса берётся не из справочника, а из того, что
 * клиника реально брала за одиночный приём этой услуги: в справочнике у одной
 * услуги цена стоит за сеанс, у другой — за весь курс, и полагаться на неё
 * нельзя.
 *
 * Допуск широкий: курс почти всегда продают со скидкой (25 000 вместо 28 000).
 * Если по сумме подходит ровно одна услуга — это она. Если несколько или ни
 * одной, а кандидат при этом единственный — тоже она. Во всех остальных
 * случаях продажа остаётся неразобранной: молчание честнее выдумки.
 */

/** Насколько сумма покупки может отличаться от плановой цены курса. */
const PRICE_TOLERANCE = 0.35;

export interface ServiceCandidate {
  /** Даты бесплатных сеансов пациента по этой услуге. */
  dates: Date[];
  /**
   * Плановая цена курса: цена одного сеанса × число сеансов в курсе.
   *
   * Ноль означает «неизвестна» — тогда услуга участвует только как кандидат
   * по сеансам, но сумму подтвердить нечем.
   */
  planPrice: number;
}

export interface SaleAssignment {
  /** Услуга → её продажи. Только те, где сомнений не осталось. */
  byService: Map<string, CourseSale[]>;
  /**
   * Продажи, которые нельзя отнести к одной услуге.
   *
   * Курс по ним не создаётся. Молчать нельзя: пациент прошёл курс, а в
   * разделе его нет — это выглядит как потеря данных, а не как честное «мы не
   * знаем, за какую из двух услуг заплатили».
   */
  ambiguous: CourseSale[];
}

/** Похожа ли сумма на плановую цену курса этой услуги. */
export function priceMatches(amount: number, planPrice: number): boolean {
  if (planPrice <= 0 || amount <= 0) return false;
  return Math.abs(amount - planPrice) <= planPrice * PRICE_TOLERANCE;
}

export function assignSales(
  sales: CourseSale[],
  candidates: Map<string, ServiceCandidate>,
  windowDays: number = SALE_WINDOW_DAYS,
): SaleAssignment {
  const byService = new Map<string, CourseSale[]>();
  const ambiguous: CourseSale[] = [];
  const windowMs = windowDays * 24 * 3600 * 1000;

  for (const sale of [...sales].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    /** Услуги, на которые пациент ходил в срок после покупки. */
    const reachable: string[] = [];
    for (const [serviceId, info] of candidates) {
      const fits = info.dates.some((d) => {
        const gap = d.getTime() - sale.at.getTime();
        return gap >= 0 && gap <= windowMs;
      });
      if (fits) reachable.push(serviceId);
    }
    if (reachable.length === 0) continue; // продажа не про курс — это молчание

    // Сумма покупки — самый сильный довод: спрашиваем сначала её.
    const byPrice = reachable.filter((id) =>
      priceMatches(sale.amount, candidates.get(id)?.planPrice ?? 0),
    );
    const winner =
      byPrice.length === 1 ? byPrice[0] : reachable.length === 1 ? reachable[0] : null;

    if (winner === null) {
      ambiguous.push(sale);
      continue;
    }
    byService.set(winner, [...(byService.get(winner) ?? []), sale]);
  }

  return { byService, ambiguous };
}

/**
 * Цена одного сеанса по недавним оплатам.
 *
 * Берём медиану последних платежей, а не всей истории: клиника поднимает цены,
 * и БОС-терапия за два года стоила 2 300, 2 500 и 2 800 ₽. Медиана по всей
 * истории застряла бы на позапрошлогодней цене, и плановая цена курса — а по
 * ней мы узнаём, какой курс купили, — считалась бы от неверной величины.
 *
 * Медиана, а не среднее: среди оплат попадаются продажи курса записью
 * (25 000 ₽), среднее они утащили бы в потолок.
 *
 * Суммы должны прийти от новых к старым — так их отдаёт база.
 */
export function recentSessionPrice(amountsNewestFirst: number[], take = 20): number {
  const recent = amountsNewestFirst.filter((a) => a > 0).slice(0, take);
  if (recent.length === 0) return 0;
  const sorted = [...recent].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
