import { prisma } from "@/lib/db";
import { startOfClinicDay } from "@/lib/clinic-time";
import { coursePurchasesBetween } from "./course-revenue";
import { averageCheck } from "@/lib/metrics/summary";

/**
 * Выручка по дням.
 *
 * ИИ-аналитику владельца давали только итоги за неделю, за тридцать дней и
 * помесячную динамику. На вопрос «какая выручка была вчера» он честно отвечал,
 * что дневного среза в сводке нет, — и это выглядело как беспомощность,
 * притом что данные лежат в базе.
 *
 * День считается в зоне клиники: сутки, начавшиеся в полночь по Москве, а не
 * по часам сервера. Выручка — та же, что во всех отчётах: стоимость услуг
 * состоявшегося визита (§8). Отдельной арифметики здесь нет намеренно, иначе у
 * клиники появится ещё одна правда о деньгах.
 */

export interface RevenueSlice {
  name: string;
  arrived: number;
  revenue: number;
}

export interface RevenueDay {
  /** «2026-08-18». */
  date: string;
  /** «18 августа, вторник». */
  label: string;
  arrived: number;
  /** Первичные: первый в истории пациента визит со статусом «пришёл» (§8). */
  firstVisits: number;
  /** Все остальные пришедшие. Первичные плюс повторные равны пришедшим. */
  repeatVisits: number;
  noShow: number;
  revenue: number;
  avgCheck: number;
  /**
   * Продано курсов в этот день — и на какую сумму.
   *
   * Курс пробивают кассой, а не приёмом, и его деньги приходят в день продажи.
   * Без этой строки день, когда клиника продала курс за 28 000 ₽, выглядел
   * беднее, чем был.
   */
  coursesSold: number;
  coursesRevenue: number;
  /**
   * Приёмы, денег в этот день не принёсшие: сеансы оплаченного курса.
   *
   * Без этого числа день читается неверно. «Восемь приёмов, 12 000 ₽» выглядит
   * как провал или как потерянные данные, хотя шесть из восьми — сеансы курса,
   * оплаченного в день продажи. Средний чек по ним тоже не считается.
   */
  courseSessions: number;
  /**
   * Из чего сложился день: по специалистам и по услугам.
   *
   * Дневного итога мало. Владелец, увидев «18 августа — 87 900 ₽», сразу
   * спрашивает, из чего это, и упирается в ту же стену: в сводке лежит только
   * сумма. Разрезы даём по нескольким последним дням — за месяц это была бы
   * простыня, которую модель всё равно не удержит.
   */
  byStaff: RevenueSlice[];
  byService: RevenueSlice[];
}

const dayLabel = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "long",
  weekday: "long",
});
const dayKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Дневная выручка за последние `days` суток, включая сегодня. Дни без визитов
 * тоже возвращаются: «в среду не было ни одного приёма» — это ответ, а
 * пропущенная строка выглядит как потерянные данные.
 */
export async function revenueByDay(
  companyId: string,
  days = 30,
  now = new Date(),
  /** По скольким последним дням давать разрез «из чего сложилось». */
  detailDays = 7,
): Promise<RevenueDay[]> {
  const from = startOfClinicDay(new Date(now.getTime() - (days - 1) * 24 * 3600 * 1000));
  const to = new Date(startOfClinicDay(now).getTime() + 24 * 3600 * 1000);

  const rows = await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      status: { in: ["ARRIVED", "NO_SHOW"] },
      startAt: { gte: from, lt: to },
    },
    select: {
      startAt: true,
      status: true,
      revenue: true,
      revenueSource: true,
      // Первичный визит — первый в истории пациента со статусом «пришёл» (§8).
      isFirstVisit: true,
      staff: { select: { name: true } },
      /**
       * Состав визита, а не только основная услуга.
       *
       * У записи основная услуга одна, а услуг в ней бывает несколько. Разрез
       * по основной терял вторую целиком: услуга, которая всегда идёт второй,
       * показывала ноль навсегда. Отчёт по услугам считает по составу — и
       * дневной разрез обязан считать так же, иначе у клиники две правды (§8).
       */
      primaryService: { select: { title: true } },
      services: { select: { priceCharged: true, service: { select: { title: true } } } },
    },
  });

  interface DayAcc {
    arrived: number;
    /**
     * Первичные: первый в истории пациента визит со статусом «пришёл» (§8).
     *
     * Без этого числа ИИ-аналитик не мог ответить на «сколько сегодня
     * первичных» — в дневных строках его просто не было, и модель отвечала
     * общими словами о данных, которых ей не дали.
     */
    first: number;
    noShow: number;
    /**
     * Оплаченные чеки дня — знаменатель среднего чека: приёмы с суммой плюс
     * продажи курсов. Сеанс курса и бесплатный приём в чек не идут.
     */
    paying: number;
    revenue: number;
    coursesSold: number;
    coursesRevenue: number;
    courseSessions: number;
    staff: Map<string, RevenueSlice>;
    service: Map<string, RevenueSlice>;
  }
  const empty = (): DayAcc => ({
    arrived: 0,
    first: 0,
    noShow: 0,
    paying: 0,
    revenue: 0,
    coursesSold: 0,
    coursesRevenue: 0,
    courseSessions: 0,
    staff: new Map(),
    service: new Map(),
  });

  /**
   * Продажи курсов раскладываем по тем же дням.
   *
   * Деньги за курс приходят в день покупки — это и есть выручка того дня,
   * наравне со стоимостью приёмов.
   */
  const purchases = await coursePurchasesBetween(companyId, from, to);

  const byDay = new Map<string, DayAcc>();
  for (const p of purchases) {
    const key = dayKey.format(p.at);
    const acc = byDay.get(key) ?? empty();
    acc.coursesSold += 1;
    acc.coursesRevenue += p.amount;
    acc.revenue += p.amount;
    // Продажа курса — полноценный чек: у неё есть клиент и сумма.
    acc.paying += 1;
    /**
     * Продажа курса попадает и в разрезы дня.
     *
     * Иначе сумма по услугам и по специалистам не сходится с итогом дня:
     * владелец видит 71 480 ₽ сверху и 43 480 ₽ в разбивке под ним. Услугу
     * знаем — она у курса записана; специалиста берём у сеансов курса, их
     * ведёт один человек.
     */
    const svc = acc.service.get(p.serviceTitle) ?? {
      name: p.serviceTitle,
      arrived: 0,
      revenue: 0,
    };
    svc.revenue += p.amount;
    acc.service.set(p.serviceTitle, svc);
    if (p.staffName) {
      const st = acc.staff.get(p.staffName) ?? { name: p.staffName, arrived: 0, revenue: 0 };
      st.revenue += p.amount;
      acc.staff.set(p.staffName, st);
    }
    byDay.set(key, acc);
  }

  for (const r of rows) {
    const key = dayKey.format(r.startAt);
    const acc = byDay.get(key) ?? empty();
    if (r.status === "ARRIVED") {
      acc.arrived += 1;
      if (r.isFirstVisit) acc.first += 1;
      acc.revenue += Number(r.revenue);
      if (Number(r.revenue) > 0) acc.paying += 1;
      if (r.revenueSource === "PREPAID") acc.courseSessions += 1;

      const add = (map: Map<string, RevenueSlice>, name: string) => {
        const cur = map.get(name) ?? { name, arrived: 0, revenue: 0 };
        cur.arrived += 1;
        cur.revenue += Number(r.revenue);
        map.set(name, cur);
      };
      add(acc.staff, r.staff?.name ?? "специалист не указан");

      /**
       * Деньги услуги — её собственная стоимость из состава визита.
       *
       * Складывать всю сумму визита каждой его услуге нельзя: приём из двух
       * позиций удвоил бы деньги дня в разрезе. Состав знает, сколько стоила
       * каждая.
       */
      if (r.services.length > 0) {
        for (const sv of r.services) {
          const name = sv.service.title;
          const cur = acc.service.get(name) ?? { name, arrived: 0, revenue: 0 };
          cur.arrived += 1;
          cur.revenue += Number(sv.priceCharged);
          acc.service.set(name, cur);
        }
      } else {
        // Состав ещё не записан (визит не менялся с тех пор, как его начали
        // писать) — тогда остаётся основная услуга.
        add(acc.service, r.primaryService?.title ?? "услуга не указана");
      }
    } else {
      acc.noShow += 1;
    }
    byDay.set(key, acc);
  }

  const bySize = (a: RevenueSlice, b: RevenueSlice) => b.revenue - a.revenue || b.arrived - a.arrived;

  const out: RevenueDay[] = [];
  for (let i = 0; i < days; i++) {
    const at = new Date(from.getTime() + i * 24 * 3600 * 1000);
    if (at >= to) break;
    const key = dayKey.format(at);
    const v = byDay.get(key) ?? empty();
    // Разрезы — только по последним дням: за месяц это простыня, которую
    // модель всё равно не удержит, а вопросы задают про свежее.
    const detailed = i >= days - detailDays;
    out.push({
      date: key,
      label: dayLabel.format(at),
      arrived: v.arrived,
      firstVisits: v.first,
      repeatVisits: v.arrived - v.first,
      noShow: v.noShow,
      revenue: v.revenue,
      avgCheck: averageCheck(v.revenue, v.paying),
      coursesSold: v.coursesSold,
      coursesRevenue: v.coursesRevenue,
      courseSessions: v.courseSessions,
      byStaff: detailed ? [...v.staff.values()].sort(bySize) : [],
      byService: detailed ? [...v.service.values()].sort(bySize) : [],
    });
  }
  return out;
}
