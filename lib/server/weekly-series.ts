import { prisma } from "@/lib/db";
import { coursePurchasesBetween } from "@/lib/server/course-revenue";

/**
 * Недельные ряды клиники — один источник на все экраны.
 *
 * Этот код жил внутри `getWeeklyDynamics` и рисовал график в кабинете
 * владельца. Еженедельной сводке нужны те же недели, и написать для неё
 * второй расчёт значило бы завести вторую правду о выручке недели — ровно ту
 * ошибку, из-за которой график когда-то показывал 174 000 ₽ там, где отчёт
 * показывал 240 455 ₽ (§8, «одна функция на метрику»). Поэтому расчёт вынесен
 * сюда целиком, а не скопирован.
 *
 * Права здесь не проверяются: это внутренняя сборка. Проверку делает
 * вызывающий — серверное действие или ночной прогон.
 */

/** Понедельник недели, в которую попадает дата, в миллисекундах UTC. */
export function weekStartMs(d: Date, offsetHours = 3): number {
  const local = new Date(d.getTime() + offsetHours * 3600 * 1000);
  const dow = (local.getUTCDay() + 6) % 7; // 0 = понедельник
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow);
}

export interface WeekBucket {
  /** Понедельник недели, мс UTC. */
  key: number;
  revenue: number;
  /** Разные пациенты недели. */
  clients: number;
  /** Состоявшиеся приёмы. */
  appts: number;
  /** Оплаченные чеки: приёмы с суммой плюс проданные курсы (§8). */
  paying: number;
  first: number;
  repeat: number;
  newPatients: number;
}

/**
 * Полные недели за `weeks` назад, от старой к свежей.
 *
 * Текущая неделя не входит НИКОГДА: она не закончилась, и сравнивать четыре
 * её дня с восемью полными неделями — значит каждый понедельник объявлять
 * обвал выручки.
 */
export async function weeklyBuckets(
  companyId: string,
  weeks: number,
  now: Date = new Date(),
): Promise<WeekBucket[]> {
  const currentWeek = weekStartMs(now);
  const since = new Date(currentWeek - weeks * 7 * 24 * 3600 * 1000);

  const [rows, fresh, purchases] = await Promise.all([
    prisma.appointment.findMany({
      // Верхняя граница обязательна: без неё в ряд попадают будущие недели.
      where: {
        companyId,
        deletedAt: null,
        status: "ARRIVED",
        startAt: { gte: since, lt: now },
      },
      select: { startAt: true, revenue: true, patientId: true, isFirstVisit: true },
    }),
    /** Новые пациенты недели — по дате первого обращения, как в отчётах (§8). */
    prisma.patient.findMany({
      where: {
        companyId,
        deletedAt: null,
        firstSeenExact: true,
        firstSeenAt: { gte: since, lt: now },
      },
      select: { firstSeenAt: true },
    }),
    coursePurchasesBetween(companyId, since, now),
  ]);

  interface Acc {
    revenue: number;
    clients: Set<string>;
    appts: number;
    paying: number;
    first: number;
    newPatients: number;
  }
  const empty = (): Acc => ({
    revenue: 0,
    clients: new Set<string>(),
    appts: 0,
    paying: 0,
    first: 0,
    newPatients: 0,
  });
  const buckets = new Map<number, Acc>();
  const at = (key: number): Acc => {
    const b = buckets.get(key) ?? empty();
    buckets.set(key, b);
    return b;
  };

  for (const r of rows) {
    const b = at(weekStartMs(r.startAt));
    b.revenue += Number(r.revenue);
    if (r.patientId) b.clients.add(r.patientId);
    b.appts += 1;
    if (r.isFirstVisit) b.first += 1;
    if (Number(r.revenue) > 0) b.paying += 1;
  }
  for (const p of fresh) at(weekStartMs(p.firstSeenAt)).newPatients += 1;
  /**
   * Проданные курсы — в ту неделю, в которую куплены. Приёмом продажа не
   * считается (приёмом были её сеансы, они уже посчитаны), а чеком — да: у
   * неё есть клиент и сумма.
   */
  for (const p of purchases) {
    const b = at(weekStartMs(p.at));
    b.revenue += p.amount;
    b.paying += 1;
  }

  /**
   * Недели без единой строки в базе — это НОЛЬ, а не пропуск.
   *
   * Пропущенная неделя молча укорачивает историю, и восемь недель наблюдений
   * превращаются в шесть; хуже того, медиана считается по тем неделям, где
   * что-то было, и «обычным» становится рабочий уровень, даже если клиника
   * половину срока не работала.
   */
  const out: WeekBucket[] = [];
  for (let i = weeks; i >= 1; i -= 1) {
    const key = currentWeek - i * 7 * 24 * 3600 * 1000;
    const b = buckets.get(key) ?? empty();
    out.push({
      key,
      revenue: b.revenue,
      clients: b.clients.size,
      appts: b.appts,
      paying: b.paying,
      first: b.first,
      // Повторные считаем здесь, а не отдаём вычитать читателю (§8).
      repeat: b.appts - b.first,
      newPatients: b.newPatients,
    });
  }
  return out;
}
