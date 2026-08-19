/**
 * Как разделить время визита между его услугами.
 *
 * У записи YCLIENTS длительность одна на весь приём, а услуг в ней бывает
 * несколько. Делим пропорционально длительности услуг из справочника — и
 * обязательно так, чтобы сумма частей была РОВНО равна времени визита.
 *
 * Это не аккуратность ради аккуратности. Разрез по услугам и разрез по
 * кабинетам считают один и тот же период: если части не сойдутся, два экрана
 * покажут разные итоги, и доверия не будет ни одному. Именно на таких
 * расхождениях этот проект уже обжигался.
 */

export interface VisitPart {
  serviceId: string;
  /** Длительность услуги по справочнику. 0 — неизвестна. */
  minutes: number;
  /** Сколько раз услуга встретилась в записи. */
  quantity: number;
  /** Деньги по этой услуге. */
  amount: number;
}

export interface SplitRow {
  serviceId: string;
  durationMin: number;
  quantity: number;
  priceCharged: number;
}

/**
 * Разложить время визита по услугам.
 *
 * Остаток от округления отдаём самой длинной части: иначе сумма минут по
 * услугам отличалась бы от длительности визита на минуту-две, и разрезы
 * разъехались бы на ровном месте.
 */
export function splitVisitMinutes(parts: VisitPart[], visitMinutes: number): SplitRow[] {
  if (parts.length === 0) return [];

  const total = parts.reduce((sum, p) => sum + p.minutes, 0);
  // Длительностей нет ни у одной услуги — делим поровну.
  const weights = total > 0 ? parts.map((p) => p.minutes / total) : parts.map(() => 1 / parts.length);

  const rows: SplitRow[] = parts.map((p, i) => ({
    serviceId: p.serviceId,
    quantity: p.quantity,
    priceCharged: p.amount,
    durationMin: Math.floor(visitMinutes * weights[i]),
  }));

  // Остаток — самой длинной части: она и так больше всех, перекос незаметен.
  const assigned = rows.reduce((sum, r) => sum + r.durationMin, 0);
  const rest = visitMinutes - assigned;
  if (rest !== 0) {
    let biggest = 0;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].durationMin > rows[biggest].durationMin) biggest = i;
    }
    rows[biggest].durationMin += rest;
  }
  return rows;
}
