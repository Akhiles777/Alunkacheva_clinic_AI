/**
 * Прогноз неявки — на явных правилах, без обучения.
 *
 * Данных у клиники мало (сотни визитов за квартал), и модель на них была бы
 * непроверяемой: администратор спросит «почему риск высокий», а ответить будет
 * нечем. Правила прозрачны, настраиваются и отлаживаются, а рядом с пометкой
 * всегда стоит основание словами — без него это гадание, и по нему перестанут
 * звонить.
 *
 * Здесь только счёт. Сбор данных — в `lib/server/no-show.ts`, веса — в
 * настройках клиники (их подбирают по её же истории, `scripts/noshow-weights.ts`).
 */

/**
 * Признаки. Каждый может быть НЕИЗВЕСТЕН — тогда его нет вовсе, а не ноль:
 * «истории мало» и «история хорошая» — разные вещи, и складывать их нельзя.
 */
export interface NoShowFacts {
  /** Доля неявок пациента среди состоявшихся и пропущенных визитов. */
  historyRate: number | null;
  /** Сколько таких визитов было — по нему решаем, можно ли говорить о доле. */
  historyVisits: number;
  /** Сколько дней между созданием записи и приёмом. */
  horizonDays: number | null;
  /** Это первый визит: состоявшихся визитов у человека ещё не было. */
  firstVisit: boolean;
  /** Клиника писала после записи, пациент не ответил. */
  unconfirmed: boolean | null;
  /** Доля неявок клиники в этом слоте (день недели и час) за 180 дней. */
  slotRate: number | null;
  /** Сколько записей клиники стоит за этой долей: по трём судить нельзя. */
  slotVisits: number;
  /** Сеанс курса позже обычного ритма пациента. */
  courseOverdue: boolean | null;
  /** Эту запись уже переносили. */
  moved: boolean | null;
}

/** Веса. Живут в настройках клиники, а не в коде: их подбирают по её данным. */
export interface NoShowWeights {
  history: number;
  horizon: number;
  firstVisit: number;
  unconfirmed: number;
  slot: number;
  courseOverdue: number;
  moved: number;
  /** Начиная с этой суммы запись помечается «стоит подтвердить». */
  threshold: number;
  /** Кем и когда утверждены — на экране это подписано. */
  approvedAt?: string | null;
}

/** Сколько прошлых визитов нужно, чтобы говорить о доле неявок пациента. */
export const MIN_HISTORY_VISITS = 3;
/** И сколько записей клиники — чтобы говорить о доле неявок в слоте. */
export const MIN_SLOT_VISITS = 20;
/** С какого горизонта запись считается сделанной «сильно заранее». */
export const FAR_HORIZON_DAYS = 14;

export type NoShowLevel = "raised" | "usual";

export interface NoShowVerdict {
  level: NoShowLevel;
  /** Сумма весов сработавших признаков. Наружу не показывается (§1.3). */
  score: number;
  /**
   * Почему — словами и с числами. Без основания пометка читается как
   * «система так решила», и звонить по ней перестают.
   */
  reasons: string[];
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/**
 * Уровень риска.
 *
 * Двухуровневый намеренно: «повышенный» и «обычный». Процент создавал бы
 * впечатление точности, которой у правил нет, а третий уровень заставил бы
 * администратора выбирать между «высоким» и «средним» — решение, которое он
 * всё равно принимает одним действием: позвонить или нет.
 *
 * Пациент без истории выше «обычного» не поднимается, если других сигналов
 * нет: незнакомый человек не значит ненадёжный.
 */
export function noShowVerdict(facts: NoShowFacts, w: NoShowWeights): NoShowVerdict {
  const reasons: string[] = [];
  let score = 0;

  if (facts.historyRate !== null && facts.historyVisits >= MIN_HISTORY_VISITS) {
    const missed = Math.round(facts.historyRate * facts.historyVisits);
    if (missed > 0) {
      score += w.history * facts.historyRate;
      reasons.push(
        `не пришёл ${missed} ${plural(missed, "раз", "раза", "раз")} из ${facts.historyVisits}`,
      );
    }
  }

  if (facts.horizonDays !== null && facts.horizonDays >= FAR_HORIZON_DAYS) {
    score += w.horizon;
    reasons.push(`записан за ${facts.horizonDays} ${plural(facts.horizonDays, "день", "дня", "дней")}`);
  }

  if (facts.firstVisit) {
    score += w.firstVisit;
    reasons.push("первый визит");
  }

  if (facts.unconfirmed === true) {
    score += w.unconfirmed;
    reasons.push("не ответил на сообщение клиники");
  }

  if (facts.slotRate !== null && facts.slotVisits >= MIN_SLOT_VISITS && facts.slotRate > 0) {
    score += w.slot * facts.slotRate;
    reasons.push(`в это время не приходят чаще обычного (${Math.round(facts.slotRate * 100)}%)`);
  }

  if (facts.courseOverdue === true) {
    score += w.courseOverdue;
    reasons.push("выпадает из ритма курса");
  }

  if (facts.moved === true) {
    score += w.moved;
    reasons.push("запись уже переносили");
  }

  /**
   * Незнакомый человек не значит ненадёжный: одного «первого визита» мало,
   * чтобы звать администратора звонить. Нужен хотя бы ещё один сигнал.
   */
  const onlyFirstVisit = facts.firstVisit && reasons.length === 1;
  const level: NoShowLevel = !onlyFirstVisit && score >= w.threshold ? "raised" : "usual";

  return { level, score: Math.round(score * 1000) / 1000, reasons };
}

/**
 * Считать ли прогноз для этой записи вообще.
 *
 * Состоявшийся или отменённый приём предсказывать нечего; блокировка времени
 * без пациента — не запись; запись, созданная сегодня на сегодня, горизонта не
 * имеет, но сама по себе прогноз не отменяет.
 */
export function predictable(appt: {
  status: string;
  patientId: string | null;
  startAt: Date;
}, now: Date = new Date()): boolean {
  if (!appt.patientId) return false;
  if (appt.status !== "CREATED" && appt.status !== "CONFIRMED") return false;
  return appt.startAt.getTime() > now.getTime();
}
