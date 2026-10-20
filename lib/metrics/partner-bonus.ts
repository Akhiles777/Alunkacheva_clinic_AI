/**
 * Бонус школе-партнёру за пришедшего по акции.
 *
 * Бонус ОДИН на привязку, а не на визит и не на запись. «Школьный ресурс 6+» в
 * YCLIENTS — составная услуга: её части («Школьный ресурс» 3 210 / 800 /
 * 2 290 ₽) стоят в разных записях у разных специалистов, и бонус на запись дал
 * бы школе 1 500 ₽ вместо 500.
 *
 * Визит акции — ГРУППА записей с одним ключом (`visitKey`): номер визита
 * YCLIENTS, а без него — сама запись. Визит «пришёл», если пришёл хотя бы в
 * одной своей записи; «отменён» — если не осталось ни одной живой.
 *
 * Начисление запускает первый подходящий визит — все условия сразу:
 *   — привязка подтверждена (не «на проверке» и не отклонена);
 *   — пациент новый для клиники: повторный пациент бонуса не приносит;
 *   — визит пришёл, в нём есть услуга акции;
 *   — не раньше привязки и не позже конца акции плюс GRACE_DAYS.
 * Сумма — замороженная в привязке, а не текущая настройка акции.
 *
 * Визит отменили, отметили неявкой, удалили или сняли отметку «пришёл»:
 *   — есть другой пришедший визит акции — бонус переходит на него;
 *   — нет — бонус снимается (REVERSED) с причиной словами.
 * Снятый автоматикой бонус возвращается сам, когда появится пришедший визит:
 * перенос — это отмена старой записи и новая запись, и терять на нём бонус
 * нельзя. Ручное (поставленное или снятое администратором) не трогается.
 *
 * Второй ребёнок той же карточки. Детей записывают на родителя, и визиты двух
 * детей — визиты одной карточки. Отличить «вторую часть пакета первого
 * ребёнка» от «второго ребёнка» можно только по повтору: одна и та же услуга
 * акции, оказанная карточке второй раз (или записанная количеством 2), —
 * второй человек. Нет повтора — второму бонуса нет: догадка не подаётся как
 * факт.
 */

export const GRACE_DAYS = 30;
const DAY = 24 * 3600_000;

export interface PromoRule {
  serviceIds: number[];
  startsAt: Date;
  endsAt: Date;
}

/** Запись YCLIENTS в проекции. */
export interface VisitFact {
  id: string;
  startAt: Date;
  status: string;
  deleted: boolean;
  /** Услуги записи: номер YCLIENTS (null — услуга заведена только у нас) и количество. */
  services: { yclientsServiceId: number | null; quantity: number }[];
  /** Ключ визита (`visitKeyOf`). Пусто — запись сама себе визит. */
  visitKey?: string;
}

export interface BonusFact {
  id: string;
  status: "EARNED" | "REVERSED";
  /** Пусто — бонус поставлен руками. */
  triggeredByAppointmentId: string | null;
  triggeredByVisitKey?: string | null;
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
  /** Привязка подтверждена. «На проверке» и отклонённая бонуса не получают. */
  confirmed?: boolean;
  /** Пациент был у клиники до начала акции — привязка есть, бонуса нет. */
  returning?: boolean;
}

export type BonusAction =
  /** bonusId — снятый бонус начисляется заново той же строкой. */
  | {
      kind: "earn";
      attributionId: string;
      appointmentId: string;
      visitKey: string;
      amount: number;
      earnedAt: Date;
      bonusId?: string;
    }
  /** Визит основания перестал годиться, но есть другой пришедший — бонус переходит на него. */
  | { kind: "retarget"; bonusId: string; attributionId: string; appointmentId: string; visitKey: string }
  | { kind: "reverse"; bonusId: string; attributionId: string; reason: string };

export function graceEnd(promo: PromoRule): Date {
  return new Date(promo.endsAt.getTime() + GRACE_DAYS * DAY);
}

/**
 * Ключ визита: номер визита YCLIENTS, иначе запись сама по себе. Запасной ключ
 * из спецификации («пациент + время + услуга») здесь не нужен: каждая запись
 * YCLIENTS приходит с visit_id, а без него запись не может быть частью чужого
 * визита — склеивать её с соседями по времени значило бы угадывать.
 */
export function visitKeyOf(record: { id: string; yclientsVisitId?: number | null }): string {
  return record.yclientsVisitId ? `v:${record.yclientsVisitId}` : `r:${record.id}`;
}

/** Сколько услуг акции в записи (с количеством) — по каждой услуге отдельно. */
function promoUnits(record: VisitFact, serviceIds: Set<number>): Map<number, number> {
  const units = new Map<number, number>();
  for (const s of record.services) {
    if (s.yclientsServiceId == null || !serviceIds.has(s.yclientsServiceId)) continue;
    units.set(s.yclientsServiceId, (units.get(s.yclientsServiceId) ?? 0) + Math.max(1, s.quantity));
  }
  return units;
}

/** Визит акции: записи с одним ключом, где есть услуга акции. */
export interface PromoVisit {
  key: string;
  startAt: Date;
  records: VisitFact[];
  /** Пришедшая запись визита — на неё ссылается бонус. Пусто — визит не пришёл. */
  arrivedRecordId: string | null;
  /** Пришёл в окне акции (начало — конец + GRACE_DAYS). */
  inWindow: boolean;
  /** Услуги акции визита с количеством — для второго ребёнка. */
  units: Map<number, number>;
}

/**
 * Записи → визиты акции. Записи без услуги акции в визит не входят, но визит,
 * где есть хотя бы одна такая запись, — визит акции (в нём бывают и обычные
 * услуги: они остаются обычной выручкой).
 */
export function promoVisits(promo: PromoRule, records: VisitFact[]): PromoVisit[] {
  const serviceIds = new Set(promo.serviceIds);
  const until = graceEnd(promo).getTime();
  const groups = new Map<string, VisitFact[]>();
  for (const r of records) {
    if (promoUnits(r, serviceIds).size === 0) continue;
    const key = r.visitKey ?? `r:${r.id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const visits: PromoVisit[] = [];
  for (const [key, list] of groups) {
    const ordered = [...list].sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.id.localeCompare(b.id));
    const arrived = ordered.find((r) => !r.deleted && r.status === "ARRIVED") ?? null;
    const units = new Map<number, number>();
    for (const r of ordered) {
      if (r.deleted || r.status === "CANCELLED") continue;
      for (const [s, n] of promoUnits(r, serviceIds)) units.set(s, (units.get(s) ?? 0) + n);
    }
    const startAt = (arrived ?? ordered[0]).startAt;
    visits.push({
      key,
      startAt,
      records: ordered,
      arrivedRecordId: arrived?.id ?? null,
      inWindow: startAt.getTime() >= promo.startsAt.getTime() && startAt.getTime() <= until,
      units,
    });
  }
  return visits.sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.key.localeCompare(b.key));
}

/** Почему визит не годится как основание бонуса — словами, для отчёта. */
export function visitLostReason(visit: PromoVisit | undefined): string | null {
  if (!visit) return "визит больше не найден в записях";
  if (visit.arrivedRecordId && visit.inWindow) return null;
  if (visit.arrivedRecordId) return "визит вне срока акции";
  const live = visit.records.filter((r) => !r.deleted);
  if (live.length === 0) return "визит удалён в YCLIENTS";
  if (live.some((r) => r.status === "NO_SHOW")) return "неявка";
  if (live.every((r) => r.status === "CANCELLED")) return "визит отменён";
  return "снята отметка «пришёл»";
}

/**
 * «Номер человека», которого может представлять визит: сколько раз к этому
 * визиту включительно карточке оказана самая повторённая услуга акции.
 */
function visitLevels(visits: PromoVisit[]): Map<string, number> {
  const running = new Map<number, number>();
  const levels = new Map<string, number>();
  for (const v of visits) {
    let level = 0;
    for (const [service, n] of v.units) {
      const before = running.get(service) ?? 0;
      running.set(service, before + n);
      level = Math.max(level, before + n);
    }
    levels.set(v.key, level);
  }
  return levels;
}

/** Привязка сейчас может получить бонус (от визитов не зависит). */
function eligible(a: AttributionFact): boolean {
  return !a.removed && a.hasSchool !== false && a.confirmed !== false && !a.returning;
}

/** Почему привязка больше не даёт бонуса — словами. */
function attributionLostReason(a: AttributionFact): string | null {
  if (a.removed) return "привязка снята";
  if (a.confirmed === false) return "привязка не подтверждена";
  if (a.returning) return "повторный пациент";
  if (a.hasSchool === false) return "школу убрали";
  return null;
}

/**
 * Что сделать с бонусами одной карточки по одной акции. Идемпотентно: на тех
 * же фактах повторный вызов после применения действий ничего не возвращает.
 */
export function bonusActions(promo: PromoRule, attributions: AttributionFact[], records: VisitFact[]): BonusAction[] {
  const all = promoVisits(promo, records);
  const qualifying = all.filter((v) => v.arrivedRecordId && v.inWindow);
  const levels = visitLevels(qualifying);
  /** Сколько человек представляет визит: «приём остеопата × 2» — двое детей. */
  const capacity = new Map(qualifying.map((v) => [v.key, Math.max(0, ...v.units.values())]));
  const used = new Map<string, number>();
  const markUsed = (key: string) => used.set(key, (used.get(key) ?? 0) + 1);
  const freeVisitFor = (a: AttributionFact) =>
    qualifying.find(
      (v) =>
        (used.get(v.key) ?? 0) < (capacity.get(v.key) ?? 0) &&
        v.startAt.getTime() >= a.attributedAt.getTime() &&
        (levels.get(v.key) ?? 0) >= a.childNo,
    );
  const visitOfBonus = (b: BonusFact) =>
    all.find(
      (v) =>
        (b.triggeredByVisitKey && v.key === b.triggeredByVisitKey) ||
        (b.triggeredByAppointmentId && v.records.some((r) => r.id === b.triggeredByAppointmentId)),
    );

  const actions: BonusAction[] = [];
  const lost: { a: AttributionFact; bonus: BonusFact; reason: string }[] = [];

  // Сначала держим действующие бонусы на их визитах — чтобы новые не заняли их места.
  for (const a of attributions) {
    const b = a.bonus;
    if (b?.status !== "EARNED") continue;
    // Ручное не перетирается: и начисленное руками, и снятое руками.
    if (b.manual || !b.triggeredByAppointmentId) continue;
    const byAttribution = attributionLostReason(a);
    if (byAttribution) {
      actions.push({ kind: "reverse", bonusId: b.id, attributionId: a.id, reason: byAttribution });
      continue;
    }
    const visit = visitOfBonus(b);
    const reason = visitLostReason(visit);
    if (reason) {
      lost.push({ a, bonus: b, reason });
      continue;
    }
    markUsed(visit!.key);
    // Визит тот же, но запись основания больше не «пришла» — ссылаемся на пришедшую.
    const keyChanged = Boolean(b.triggeredByVisitKey) && visit!.key !== b.triggeredByVisitKey;
    if (visit!.arrivedRecordId !== b.triggeredByAppointmentId || keyChanged) {
      actions.push({
        kind: "retarget",
        bonusId: b.id,
        attributionId: a.id,
        appointmentId: visit!.arrivedRecordId!,
        visitKey: visit!.key,
      });
    }
  }

  // Визит основания пропал: другой пришедший визит акции — бонус переходит, иначе снимается.
  for (const { a, bonus, reason } of lost) {
    const other = freeVisitFor(a);
    if (other) {
      markUsed(other.key);
      actions.push({
        kind: "retarget",
        bonusId: bonus.id,
        attributionId: a.id,
        appointmentId: other.arrivedRecordId!,
        visitKey: other.key,
      });
    } else {
      actions.push({ kind: "reverse", bonusId: bonus.id, attributionId: a.id, reason });
    }
  }

  /**
   * Кому начислить. Снятый автоматикой бонус (не руками) начисляется заново той
   * же строкой, как только привязка снова годится и есть пришедший визит.
   */
  const pending = attributions
    .filter(
      (a) =>
        eligible(a) &&
        !a.completed &&
        !a.bonus?.manual &&
        (!a.bonus || a.bonus.status === "REVERSED"),
    )
    .sort((x, y) => x.childNo - y.childNo);
  for (const a of pending) {
    const visit = freeVisitFor(a);
    if (!visit) continue;
    markUsed(visit.key);
    actions.push({
      kind: "earn",
      attributionId: a.id,
      appointmentId: visit.arrivedRecordId!,
      visitKey: visit.key,
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
