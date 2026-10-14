/**
 * Бонус школе-партнёру за пришедшего по акции.
 *
 * Бонус ОДИН на привязку, а не на визит: check-up заводят в YCLIENTS и одной
 * комплексной услугой, и четырьмя отдельными. Бонус на визит при четырёх
 * услугах дал бы школе 2000 ₽ вместо 500. Поэтому начисление запускает ПЕРВЫЙ
 * подходящий визит, а остальные визиты пакета денег не добавляют.
 *
 * Подходящий визит — все условия сразу:
 *   — статус ARRIVED, запись не удалена;
 *   — среди услуг есть услуга акции (по номеру услуги YCLIENTS);
 *   — не раньше привязки;
 *   — не позже конца акции плюс GRACE_DAYS.
 * Сумма — замороженная в привязке, а не текущая настройка акции.
 *
 * Второй ребёнок той же семьи. Ребёнка записывают на карточку родителя, и оба
 * ребёнка приходят визитами ОДНОЙ карточки. Отличить «второй визит пакета
 * первого ребёнка» от «визит второго ребёнка» можно только по повтору: одна и
 * та же услуга акции, оказанная карточке второй раз, — это второй человек.
 * Иначе деньги школе начислялись бы за анализы того же ребёнка, сданные на
 * другой день. Не повторилась услуга — бонус второму ребёнку не начисляется:
 * догадка не подаётся как факт.
 *
 * Начисленный бонус снимается (REVERSED) с причиной, если визит отменили,
 * отметили неявкой, удалили или сняли отметку «пришёл», и если саму привязку
 * сняли. Снятый бонус не возвращается сам и не исчезает молча: он стоит в
 * отчёте отдельной строкой.
 */

export const GRACE_DAYS = 30;
const DAY = 24 * 3600_000;

export interface PromoRule {
  serviceIds: number[];
  startsAt: Date;
  endsAt: Date;
}

export interface VisitFact {
  id: string;
  startAt: Date;
  status: string;
  deleted: boolean;
  /** Услуги визита: номер YCLIENTS (null — услуга заведена только у нас) и количество. */
  services: { yclientsServiceId: number | null; quantity: number }[];
}

export interface BonusFact {
  id: string;
  status: "EARNED" | "REVERSED";
  /** Пусто — бонус поставлен руками. */
  triggeredByAppointmentId: string | null;
  reversedAt?: Date | null;
  /** Поставлен или снят руками: автоматика его не трогает ни в какую сторону. */
  manual?: boolean;
}

export interface AttributionFact {
  id: string;
  childNo: number;
  attributedAt: Date;
  removed: boolean;
  bonusAmountFrozen: number;
  bonus: BonusFact | null;
  /** Без школы бонуса нет: человек пришёл по акции сам. */
  hasSchool?: boolean;
  /** «Прошёл всё» отмечено руками — бонус ставит администратор, а не правило. */
  completed?: boolean;
}

export type BonusAction =
  /** bonusId — бонус был снят, а привязку поставили заново: строка та же. */
  | {
      kind: "earn";
      attributionId: string;
      appointmentId: string;
      amount: number;
      earnedAt: Date;
      bonusId?: string;
    }
  | { kind: "reverse"; bonusId: string; attributionId: string; reason: string };

export function graceEnd(promo: PromoRule): Date {
  return new Date(promo.endsAt.getTime() + GRACE_DAYS * DAY);
}

/** Сколько услуг акции в визите (с количеством) — по каждой услуге отдельно. */
function promoUnits(
  visit: VisitFact,
  serviceIds: Set<number>,
): Map<number, number> {
  const units = new Map<number, number>();
  for (const s of visit.services) {
    if (s.yclientsServiceId == null || !serviceIds.has(s.yclientsServiceId))
      continue;
    units.set(
      s.yclientsServiceId,
      (units.get(s.yclientsServiceId) ?? 0) + Math.max(1, s.quantity),
    );
  }
  return units;
}

/** Почему визит больше не годится как основание бонуса — словами, для отчёта. */
export function lostReason(
  visit: VisitFact | undefined,
  serviceIds: Set<number>,
): string | null {
  if (!visit) return "визит больше не найден в записях";
  if (visit.deleted) return "визит удалён в YCLIENTS";
  if (visit.status === "CANCELLED") return "визит отменён";
  if (visit.status === "NO_SHOW") return "неявка";
  if (visit.status !== "ARRIVED") return "снята отметка «пришёл»";
  if (promoUnits(visit, serviceIds).size === 0)
    return "в визите не осталось услуг акции";
  return null;
}

/**
 * «Номер человека», которого может представлять визит: сколько раз к этому
 * визиту включительно карточке оказана самая повторённая услуга акции.
 * Визит с уровнем 2 может быть визитом второго ребёнка (и первого тоже).
 */
function visitLevels(
  visits: VisitFact[],
  serviceIds: Set<number>,
): Map<string, number> {
  const running = new Map<number, number>();
  const levels = new Map<string, number>();
  for (const v of visits) {
    let level = 0;
    for (const [service, n] of promoUnits(v, serviceIds)) {
      const before = running.get(service) ?? 0;
      running.set(service, before + n);
      level = Math.max(level, before + n);
    }
    levels.set(v.id, level);
  }
  return levels;
}

/**
 * Что сделать с бонусами одной карточки по одной акции. Идемпотентно: на тех
 * же фактах повторный вызов после применения действий ничего не возвращает.
 */
export function bonusActions(
  promo: PromoRule,
  attributions: AttributionFact[],
  visits: VisitFact[],
): BonusAction[] {
  const serviceIds = new Set(promo.serviceIds);
  const byId = new Map(visits.map((v) => [v.id, v]));
  const actions: BonusAction[] = [];
  const until = graceEnd(promo).getTime();

  const qualifying = visits
    .filter(
      (v) =>
        !v.deleted &&
        v.status === "ARRIVED" &&
        v.startAt.getTime() >= promo.startsAt.getTime() &&
        v.startAt.getTime() <= until &&
        promoUnits(v, serviceIds).size > 0,
    )
    .sort(
      (a, b) =>
        a.startAt.getTime() - b.startAt.getTime() || a.id.localeCompare(b.id),
    );
  const levels = visitLevels(qualifying, serviceIds);

  /**
   * Сколько человек представляет визит: запись «приём остеопата × 2» — это
   * двое детей. Основанием бонуса визит становится не больше этого числа раз.
   */
  const capacity = new Map(
    qualifying.map((v) => [
      v.id,
      Math.max(0, ...promoUnits(v, serviceIds).values()),
    ]),
  );
  const used = new Map<string, number>();
  const markUsed = (id: string) => used.set(id, (used.get(id) ?? 0) + 1);
  for (const a of attributions) {
    if (a.bonus?.status !== "EARNED") continue;
    // Ручное не перетирается: и начисленное руками, и снятое руками.
    if (a.bonus.manual || !a.bonus.triggeredByAppointmentId) continue;
    const reason = a.removed
      ? "привязка снята"
      : lostReason(byId.get(a.bonus.triggeredByAppointmentId), serviceIds);
    if (reason)
      actions.push({
        kind: "reverse",
        bonusId: a.bonus.id,
        attributionId: a.id,
        reason,
      });
    else markUsed(a.bonus.triggeredByAppointmentId);
  }

  /**
   * Снятый бонус сам не возвращается. Исключение — привязку сняли и поставили
   * заново ПОСЛЕ снятия: это решение человека, и бонус считается заново.
   */
  const reopened = (a: AttributionFact) =>
    a.bonus?.status === "REVERSED" &&
    a.bonus.reversedAt != null &&
    a.attributedAt.getTime() > a.bonus.reversedAt.getTime();
  const pending = attributions
    .filter(
      (a) =>
        !a.removed &&
        a.hasSchool !== false &&
        !a.completed &&
        !a.bonus?.manual &&
        (!a.bonus || reopened(a)),
    )
    .sort((a, b) => a.childNo - b.childNo);
  for (const a of pending) {
    const visit = qualifying.find(
      (v) =>
        (used.get(v.id) ?? 0) < (capacity.get(v.id) ?? 0) &&
        v.startAt.getTime() >= a.attributedAt.getTime() &&
        (levels.get(v.id) ?? 0) >= a.childNo,
    );
    if (!visit) continue;
    markUsed(visit.id);
    actions.push({
      kind: "earn",
      attributionId: a.id,
      appointmentId: visit.id,
      amount: a.bonusAmountFrozen,
      earnedAt: visit.startAt,
      ...(a.bonus ? { bonusId: a.bonus.id } : {}),
    });
  }
  return actions;
}

export interface SchoolTotals {
  /** Действующие привязки. */
  attributed: number;
  /** Пришли — привязки с начисленным бонусом. */
  arrived: number;
  /** Сумма начисленных бонусов. */
  bonusEarned: number;
  /** Снятые бонусы — отдельной строкой, а не молча. */
  reversed: number;
  bonusReversed: number;
}

/** Итоги школы — одна функция для экрана клиники и публичного отчёта школы. */
export function schoolTotals(
  attributions: {
    removed: boolean;
    bonus: { status: "EARNED" | "REVERSED"; amount: number } | null;
  }[],
): SchoolTotals {
  const t: SchoolTotals = {
    attributed: 0,
    arrived: 0,
    bonusEarned: 0,
    reversed: 0,
    bonusReversed: 0,
  };
  for (const a of attributions) {
    if (!a.removed) t.attributed += 1;
    if (a.bonus?.status === "EARNED") {
      t.arrived += 1;
      t.bonusEarned += a.bonus.amount;
    } else if (a.bonus?.status === "REVERSED") {
      t.reversed += 1;
      t.bonusReversed += a.bonus.amount;
    }
  }
  return t;
}

/** Можно ли сейчас заводить новые привязки: после конца акции — нет, старые работают. */
export function canAttribute(
  promo: { isActive: boolean; endsAt: Date },
  now: Date,
): boolean {
  return promo.isActive && now.getTime() <= promo.endsAt.getTime();
}
