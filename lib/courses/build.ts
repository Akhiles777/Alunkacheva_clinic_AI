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

import type { CoursePlanOption } from "./product";

export type { CoursePlanOption };

/** Продажа курса, найденная в кассе: день и сумма. */
export interface CourseSale {
  id: string;
  at: Date;
  amount: number;
}

/**
 * Похожа ли оплата на продажу курса.
 *
 * Правило переписывалось трижды, и каждый раз его ломала одна и та же вещь —
 * цена одного сеанса, принятая за курс.
 *
 * Сначала курс открывала ЛЮБАЯ оплата: десятки платежей по цене сеанса
 * превращались в десятки «курсов 1/2». Потом — оплата от полутора цен сеанса.
 * И это сломалось на НАК-методе: сеанс там стоит то 500, то 1 000 ₽, оценка
 * цены сеанса упала до пятисот, порог стал 750 — и платёж за один сеанс снова
 * открывал курс. В карточке пациента появились три «НАК 1/10» вразброс и
 * «покупка курса — 1 000 ₽».
 *
 * Поэтому сравниваем не с сеансом, а с курсом целиком. Курс из десяти сеансов
 * по 2 800 ₽ стоит около 28 000 ₽; покупкой курса считаем то, что покрывает
 * хотя бы его половину. Половина, а не вся сумма: курс продают со скидкой и
 * иногда доплачивают частями. Но 1 000 ₽ при курсе в 10 000 ₽ — это один
 * сеанс, и никакая скидка этого не изменит.
 */

/** Какую часть курса должна покрыть оплата, чтобы считаться его покупкой. */
const MIN_COURSE_SHARE = 0.5;

export function looksLikeCourseSale(amount: number, planPrice: number): boolean {
  if (planPrice <= 0 || amount <= 0) return false;
  return amount >= planPrice * MIN_COURSE_SHARE;
}

/**
 * Какой из объявленных курсов купили.
 *
 * Клиника может продавать курс из четырёх сеансов и курс из десяти. Сумма
 * покупки и говорит, какой именно: берём тот вариант, к чьей цене она ближе,
 * из тех, что она вообще покрывает. Если не покрывает ни одного — это не
 * покупка курса.
 */
export function planForAmount(
  amount: number,
  plans: CoursePlanOption[],
): CoursePlanOption | null {
  const fits = plans.filter((p) => looksLikeCourseSale(amount, p.price));
  if (fits.length === 0) return null;
  return fits.reduce((best, p) =>
    Math.abs(amount - p.price) < Math.abs(amount - best.price) ? p : best,
  );
}

export interface BuildCoursesOptions {
  /**
   * Варианты курса: цена и число сеансов в каждом.
   *
   * Берутся из справочника клиники — карточка «БОС-терапия, курс» с ценой
   * 28 000 ₽ и пометкой «сеансов 10». Если такой карточки нет, вариант один и
   * его цена оценена как цена сеанса × размер курса. Пустой список означает
   * «неизвестно»: курсы не собираются вовсе, потому что отличить продажу
   * курса от оплаты приёма нечем.
   */
  plans: CoursePlanOption[];
  /**
   * Продажи курсов этого пациента из кассы.
   *
   * Главный источник: курс продаётся не записью приёма, а покупкой в кассе.
   * Оплата в записи остаётся запасным вариантом — она встречается, но реже.
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
  const plans = opts.plans.filter((p) => p.price > 0 && p.sessions > 0);
  const courses: PlannedCourse[] = [];
  const orphans: string[] = [];
  let open: PlannedCourse | null = null;

  /** Продажи по возрастанию времени; каждая открывает курс не больше раза. */
  const sales = [...(opts.sales ?? [])]
    .filter((s) => planForAmount(s.amount, plans) !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const usedSale = new Set<string>();
  const windowMs = SALE_WINDOW_DAYS * 24 * 3600 * 1000;

  /**
   * Самая ранняя неиспользованная продажа, случившаяся не позже сеанса.
   *
   * Именно ранняя: курсы расходуются в том порядке, в каком куплены. Раньше
   * бралась последняя, и пациент, купивший два курса подряд, начинал ходить по
   * второму — а первый висел неиспользованным до конца.
   */
  const saleFor = (at: Date): CourseSale | null => {
    for (const s of sales) {
      if (usedSale.has(s.id)) continue;
      if (s.at.getTime() > at.getTime()) break;
      if (at.getTime() - s.at.getTime() > windowMs) continue;
      return s;
    }
    return null;
  };

  for (const v of [...visits].sort((a, b) => a.startAt.getTime() - b.startAt.getTime())) {
    if (v.revenue > 0) {
      // Оплата в записи — запасной путь: так курс тоже иногда проводят.
      const plan = planForAmount(v.revenue, plans);
      if (!plan) continue;
      open = {
        purchasedAt: v.startAt,
        amount: v.revenue,
        sessionsTotal: plan.sessions,
        visitIds: [v.id],
      };
      courses.push(open);
      continue;
    }

    // Открытый курс кончился либо его не было — ищем продажу в кассе.
    if (!open || open.visitIds.length >= open.sessionsTotal) {
      const sale = saleFor(v.startAt);
      const plan = sale ? planForAmount(sale.amount, plans) : null;
      if (sale && plan) {
        usedSale.add(sale.id);
        open = {
          purchasedAt: sale.at,
          amount: sale.amount,
          // Размер курса — из того варианта, к чьей цене ближе покупка.
          sessionsTotal: plan.sessions,
          visitIds: [],
        };
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
  /** Варианты курса этой услуги: цена и число сеансов. */
  plans: CoursePlanOption[];
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

    /**
     * Покупка должна тянуть на курс.
     *
     * Без этой проверки одиночный платёж уходил в курс, стоило пациенту иметь
     * сеансы только одной курсовой услуги: кандидат один — значит он. Так
     * тысяча рублей за сеанс НАК превращалась в «курс 1/10».
     */
    const plausible = reachable.filter(
      (id) => planForAmount(sale.amount, candidates.get(id)?.plans ?? []) !== null,
    );
    if (plausible.length === 0) continue; // оплата приёма, а не курса

    // Сумма покупки — самый сильный довод: спрашиваем сначала её.
    const byPrice = plausible.filter((id) =>
      (candidates.get(id)?.plans ?? []).some((p) => priceMatches(sale.amount, p.price)),
    );
    const winner =
      byPrice.length === 1 ? byPrice[0] : plausible.length === 1 ? plausible[0] : null;

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

  /**
   * Самая частая сумма, а при равенстве — большая.
   *
   * Медиана здесь подводит: у НАК-метода сеанс стоит то 500, то 1 000 ₽
   * поровну, и медиана падала на пятьсот — вдвое ниже настоящей цены. От неё
   * считается плановая цена курса, по которой мы отличаем покупку курса от
   * оплаты приёма, и занижение открывало курсы там, где их не покупали.
   *
   * Частая сумма устойчивее: разовая продажа курса записью (25 000 ₽) её не
   * сдвигает, а новая цена становится частой сама, как только по ней начинают
   * платить.
   */
  const counts = new Map<number, number>();
  for (const a of recent) counts.set(a, (counts.get(a) ?? 0) + 1);
  let best = 0;
  let bestCount = 0;
  for (const [amount, n] of counts) {
    if (n > bestCount || (n === bestCount && amount > best)) {
      best = amount;
      bestCount = n;
    }
  }
  return best;
}
