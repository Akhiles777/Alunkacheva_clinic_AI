/**
 * Разобранность визитов: сколько прошедших приёмов остались без исхода.
 *
 * Все метрики посещаемости — доходимость, неявки, выручка дня — считаются от
 * статуса, который ставит администратор в YCLIENTS. Пока статуса нет, визит
 * не «состоялся» и не «неявка»: он висит запланированным, хотя его время
 * прошло неделю назад.
 *
 * Отсюда главная ложь этого разреза: «Неявки 0%» читается как «неявок нет»,
 * а означать может «никто ничего не отмечает». Разница решающая — в первом
 * случае клиника работает отлично, во втором мы просто не знаем.
 *
 * Поэтому число неотмеченных считается рядом ВСЕГДА и показывается рядом с
 * долей неявок. Деньги в них тоже считаются: в выручку дня такой визит не
 * попадает (§8 — деньги признаются по состоявшемуся приёму), и пока он висит
 * неразобранным, эта сумма не видна ни в одном разрезе.
 */

export type VisitStatus = "CREATED" | "CONFIRMED" | "ARRIVED" | "NO_SHOW" | "CANCELLED";

export interface VisitOutcome {
  startAt: Date;
  status: VisitStatus;
  /** Сумма, записанная в визите. Для неразобранных — то, что повисло. */
  revenue: number;
}

export interface AttendanceAudit {
  arrived: number;
  noShow: number;
  cancelled: number;
  /** Прошедшие приёмы без исхода: время было, отметки нет. */
  unmarked: number;
  /** Деньги, повисшие в неразобранных визитах. */
  unmarkedMoney: number;
  /** Самый старый неразобранный: по нему видно, копится ли это годами. */
  oldestUnmarkedAt: Date | null;
  /** Запланированные впереди — они исходом ещё быть не могли. */
  upcoming: number;
  /**
   * Доля неявок среди СОСТОЯВШИХСЯ исходов. null — исходов не было, и доля
   * неизвестна: ноль означал бы «неявок не случилось», а это другое.
   */
  noShowRate: number | null;
  /**
   * Насколько разобран период: исходы ÷ (исходы + неразобранные). Единица —
   * отмечено всё, и доле неявок можно верить.
   */
  coverage: number | null;
}

/**
 * Через сколько после начала приём считается прошедшим.
 *
 * Не «сейчас»: приём, начавшийся полчаса назад, ещё идёт, и отметки у него
 * быть не должно. Сутки — запас на то, что администратор отмечает вечером
 * или на следующее утро.
 */
export const MARK_GRACE_HOURS = 24;

export function attendanceAudit(
  visits: VisitOutcome[],
  now: Date = new Date(),
): AttendanceAudit {
  const graceMs = MARK_GRACE_HOURS * 3600 * 1000;
  let arrived = 0;
  let noShow = 0;
  let cancelled = 0;
  let unmarked = 0;
  let unmarkedMoney = 0;
  let upcoming = 0;
  let oldestUnmarkedAt: Date | null = null;

  for (const v of visits) {
    if (v.status === "ARRIVED") {
      arrived += 1;
      continue;
    }
    if (v.status === "NO_SHOW") {
      noShow += 1;
      continue;
    }
    if (v.status === "CANCELLED") {
      cancelled += 1;
      continue;
    }

    // CREATED и CONFIRMED: исход зависит от того, прошло ли время приёма.
    if (v.startAt.getTime() + graceMs > now.getTime()) {
      upcoming += 1;
      continue;
    }
    unmarked += 1;
    unmarkedMoney += v.revenue;
    if (!oldestUnmarkedAt || v.startAt < oldestUnmarkedAt) oldestUnmarkedAt = v.startAt;
  }

  const settled = arrived + noShow;
  return {
    arrived,
    noShow,
    cancelled,
    unmarked,
    unmarkedMoney,
    oldestUnmarkedAt,
    upcoming,
    noShowRate: settled === 0 ? null : noShow / settled,
    coverage: settled + unmarked === 0 ? null : settled / (settled + unmarked),
  };
}
