/**
 * Выручка по услугам и по специалистам — одной функцией на всех.
 *
 * Мест, где это считалось, оказалось три: отчёты, экран владельца и дневной
 * разрез. Каждое считало по-своему — по основной услуге визита и без продаж
 * курсов, — и БОС-терапия с сорока одним приёмом показывала ноль рублей, хотя
 * клиника получила за эти курсы сотни тысяч.
 *
 * Правила ровно два, и они общие (§8):
 *
 *   1. Услуга получает СВОИ деньги из состава визита. У записи основная услуга
 *      одна, а услуг в ней бывает несколько: считать по основной значит терять
 *      вторую целиком, а приписывать всю сумму визита каждой — удваивать её.
 *   2. Продажа курса — деньги того дня, той услуги и того специалиста, который
 *      курс ведёт. Курс пробивают кассой, приёма в этот момент может не быть
 *      вовсе, но заработан он сеансами.
 */

export interface VisitPart {
  /** Название услуги. */
  title: string;
  /** Стоимость именно этой услуги в визите. */
  amount: number;
}

export interface VisitForRevenue {
  status: string;
  doctor: string;
  /** Сумма всего визита — на случай, когда состав ещё не записан. */
  price: number;
  /** Основная услуга — тоже запасной путь. */
  service: string;
  parts: VisitPart[];
}

export interface CourseSaleForRevenue {
  serviceTitle: string;
  staffName: string | null;
  amount: number;
}

export interface RevenueRow {
  name: string;
  /** Состоявшихся приёмов по этой услуге (или у этого специалиста). */
  count: number;
  revenue: number;
}

const byRevenue = (a: RevenueRow, b: RevenueRow): number =>
  b.revenue - a.revenue || b.count - a.count;

function add(map: Map<string, RevenueRow>, name: string, count: number, revenue: number): void {
  const cur = map.get(name) ?? { name, count: 0, revenue: 0 };
  cur.count += count;
  cur.revenue += revenue;
  map.set(name, cur);
}

/** Выручка по услугам: состав визитов плюс проданные курсы. */
export function revenueByService(
  visits: VisitForRevenue[],
  sales: CourseSaleForRevenue[] = [],
): RevenueRow[] {
  const map = new Map<string, RevenueRow>();
  for (const v of visits) {
    if (v.status !== "arrived") continue;
    if (v.parts.length > 0) {
      for (const p of v.parts) add(map, p.title, 1, p.amount);
    } else {
      // Состав ещё не записан — остаётся основная услуга и сумма визита.
      add(map, v.service || "услуга не указана", 1, v.price);
    }
  }
  /**
   * Продажа курса добавляет деньги, но не приём: приёмом были его сеансы, и
   * они уже посчитаны выше. Иначе число приёмов вырастет на пустом месте.
   */
  for (const s of sales) add(map, s.serviceTitle, 0, s.amount);
  return [...map.values()].sort(byRevenue);
}

/** Выручка по специалистам: их приёмы плюс курсы, которые они ведут. */
export function revenueByStaff(
  visits: VisitForRevenue[],
  sales: CourseSaleForRevenue[] = [],
): RevenueRow[] {
  const map = new Map<string, RevenueRow>();
  for (const v of visits) {
    if (v.status !== "arrived") continue;
    add(map, v.doctor || "специалист не указан", 1, v.price);
  }
  for (const s of sales) {
    // Курс без сеансов специалиста не знает — в разрез по людям он не идёт.
    if (!s.staffName) continue;
    add(map, s.staffName, 0, s.amount);
  }
  return [...map.values()].sort(byRevenue);
}
