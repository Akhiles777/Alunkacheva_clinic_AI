/**
 * Признание выручки по курсовым услугам (IV-терапия, БОС — 8–12 сеансов).
 *
 * Пациент платит один раз за весь курс, но выручка признаётся по визиту.
 * Иначе один платёж за 10 сеансов даёт пик в день продажи и ноль в
 * остальные дни, и дневная выручка перестаёт что-либо значить.
 *
 * Считаем в копейках: 65000 / 3 в float даёт 21666.666666666668, и сумма
 * долей перестаёт сходиться с суммой продажи.
 */

const MINOR_UNITS = 100;

function toMinor(amount: number): number {
  return Math.round(amount * MINOR_UNITS);
}

function toMajor(minor: number): number {
  return minor / MINOR_UNITS;
}

/**
 * Делит сумму курса на сеансы. Остаток от неровного деления закрепляется за
 * последним сеансом, поэтому сумма долей всегда равна сумме курса — курс
 * сходится с кассой YCLIENTS до копейки.
 */
export function splitCourseAmount(amount: number, sessionsTotal: number): number[] {
  if (!Number.isInteger(sessionsTotal) || sessionsTotal <= 0) {
    throw new RangeError(`sessionsTotal должен быть положительным целым, получено ${sessionsTotal}`);
  }
  if (amount < 0) {
    throw new RangeError(`amount не может быть отрицательным, получено ${amount}`);
  }

  const totalMinor = toMinor(amount);
  const perSession = Math.floor(totalMinor / sessionsTotal);
  const remainder = totalMinor - perSession * sessionsTotal;

  return Array.from({ length: sessionsTotal }, (_, index) =>
    toMajor(index === sessionsTotal - 1 ? perSession + remainder : perSession),
  );
}

/** Доля курса, приходящаяся на конкретный сеанс. `sessionIndex` — 1-based. */
export function courseSessionRevenue(
  amount: number,
  sessionsTotal: number,
  sessionIndex: number,
): number {
  if (sessionIndex < 1 || sessionIndex > sessionsTotal) {
    throw new RangeError(
      `sessionIndex ${sessionIndex} вне курса из ${sessionsTotal} сеансов`,
    );
  }
  return splitCourseAmount(amount, sessionsTotal)[sessionIndex - 1];
}

export interface VisitRevenueInput {
  /** Оплачено по разовому визиту (из YCLIENTS). Для курсового визита не используется. */
  paidAmount: number;
  course?: {
    amount: number;
    sessionsTotal: number;
  } | null;
  /** 1-based номер сеанса внутри курса. */
  courseSessionIndex?: number | null;
}

/**
 * Признанная выручка одного визита: разовый — сколько оплачено, курсовой —
 * доля курса. Курсовой визит без номера сеанса выручку не признаёт: лучше
 * ноль, чем задвоение с продажей курса.
 */
export function recognizeVisitRevenue(input: VisitRevenueInput): number {
  const { course, courseSessionIndex, paidAmount } = input;
  if (!course) return paidAmount;
  if (!courseSessionIndex) return 0;
  return courseSessionRevenue(course.amount, course.sessionsTotal, courseSessionIndex);
}
