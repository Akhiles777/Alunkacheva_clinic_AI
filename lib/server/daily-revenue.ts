import { prisma } from "@/lib/db";
import { startOfClinicDay } from "@/lib/clinic-time";
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

export interface RevenueDay {
  /** «2026-08-18». */
  date: string;
  /** «18 августа, вторник». */
  label: string;
  arrived: number;
  noShow: number;
  revenue: number;
  avgCheck: number;
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
export async function revenueByDay(companyId: string, days = 30, now = new Date()): Promise<RevenueDay[]> {
  const from = startOfClinicDay(new Date(now.getTime() - (days - 1) * 24 * 3600 * 1000));
  const to = new Date(startOfClinicDay(now).getTime() + 24 * 3600 * 1000);

  const rows = await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      status: { in: ["ARRIVED", "NO_SHOW"] },
      startAt: { gte: from, lt: to },
    },
    select: { startAt: true, status: true, revenue: true },
  });

  const byDay = new Map<string, { arrived: number; noShow: number; revenue: number }>();
  for (const r of rows) {
    const key = dayKey.format(r.startAt);
    const acc = byDay.get(key) ?? { arrived: 0, noShow: 0, revenue: 0 };
    if (r.status === "ARRIVED") {
      acc.arrived += 1;
      acc.revenue += Number(r.revenue);
    } else {
      acc.noShow += 1;
    }
    byDay.set(key, acc);
  }

  const out: RevenueDay[] = [];
  for (let i = 0; i < days; i++) {
    const at = new Date(from.getTime() + i * 24 * 3600 * 1000);
    if (at >= to) break;
    const key = dayKey.format(at);
    const v = byDay.get(key) ?? { arrived: 0, noShow: 0, revenue: 0 };
    out.push({
      date: key,
      label: dayLabel.format(at),
      arrived: v.arrived,
      noShow: v.noShow,
      revenue: v.revenue,
      avgCheck: averageCheck(v.revenue, v.arrived),
    });
  }
  return out;
}
