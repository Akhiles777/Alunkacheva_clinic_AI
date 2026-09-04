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

/**
 * Экономика курсов.
 *
 * Курс — главный товар клиники: 28 000 ₽ за десять сеансов БОС. Всё, что с
 * ним происходит после продажи, деньгами уже не измеряется — деньги пришли в
 * день покупки (§8). Измеряется другое: доходит ли человек до конца, сколько
 * сеансов клиника должна отработать и возвращается ли он за вторым курсом.
 *
 * Общее правило этих четырёх метрик: **не судим о том, о чём судить рано**.
 * Курс, купленный вчера, не «брошен» — он идёт. Пациент, закончивший курс на
 * прошлой неделе, не «не вернулся» — у него ещё не было времени. Такие случаи
 * считаются отдельно и в доли не идут: иначе каждый свежий месяц показывает
 * ноль доходимости, и по метрике перестают смотреть.
 */

export interface CourseFact {
  courseId: string;
  patientId: string;
  serviceTitle: string;
  purchasedAt: Date;
  sessionsTotal: number;
  /** Состоявшиеся сеансы. */
  sessionsUsed: number;
  /** Записанные вперёд: место занято, приём ещё не прошёл. */
  sessionsBooked: number;
  pricePerSession: number;
  /** Даты состоявшихся сеансов по возрастанию — для интервалов. */
  sessionDates: Date[];
  /** Порог «выпал из графика» у услуги или клиники. null — судить не по чему. */
  thresholdDays: number | null;
  /** Есть ли будущая запись по этому курсу. */
  hasFuture: boolean;
}

const DAY = 24 * 3600 * 1000;

/** Медиана. Пустой ряд — null: «нет данных» это не ноль. */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface CourseCompletion {
  /** Курсы, купленные в периоде и уже решившиеся. */
  completed: number;
  abandoned: number;
  /** Ещё идут: судить рано, в долю не входят. */
  inProgress: number;
  /**
   * Доля дошедших до конца среди РЕШИВШИХСЯ курсов. null — решившихся не было,
   * и доля неизвестна. Ноль означал бы «никто не дошёл», а это другое.
   */
  rate: number | null;
  /** Сколько сеансов из оплаченных пройдено — по всем курсам периода. */
  sessionsUsed: number;
  sessionsPaid: number;
  /** Курсы, у которых нет порога: брошен курс или идёт — сказать не на чем. */
  undecidable: number;
}

/**
 * Доходимость курсов, купленных в периоде.
 *
 * Брошенным считается курс, у которого сеансы не кончились, будущей записи
 * нет, а с последнего сеанса прошло больше порога. Порога нет — курс не
 * решён, а не «идёт»: разница в том, что первое мы честно не знаем.
 */
export function courseCompletion(courses: CourseFact[], now: Date = new Date()): CourseCompletion {
  let completed = 0;
  let abandoned = 0;
  let inProgress = 0;
  let undecidable = 0;
  let sessionsUsed = 0;
  let sessionsPaid = 0;

  for (const c of courses) {
    sessionsUsed += Math.min(c.sessionsUsed, c.sessionsTotal);
    sessionsPaid += c.sessionsTotal;

    if (c.sessionsUsed >= c.sessionsTotal) {
      completed += 1;
      continue;
    }
    if (c.hasFuture || c.sessionsBooked > 0) {
      inProgress += 1;
      continue;
    }
    const last = c.sessionDates[c.sessionDates.length - 1] ?? c.purchasedAt;
    const idle = Math.floor((now.getTime() - last.getTime()) / DAY);
    if (c.thresholdDays === null) {
      undecidable += 1;
      continue;
    }
    if (idle > c.thresholdDays) abandoned += 1;
    else inProgress += 1;
  }

  const decided = completed + abandoned;
  return {
    completed,
    abandoned,
    inProgress,
    rate: decided === 0 ? null : completed / decided,
    sessionsUsed,
    sessionsPaid,
    undecidable,
  };
}

export interface OutstandingCourses {
  /**
   * Оплаченные, но не проведённые сеансы — в рублях.
   *
   * Это ОБЯЗАТЕЛЬСТВО клиники, а не её выручка: деньги получены в день
   * продажи и уже посчитаны выручкой того дня (§8). Складывать это число с
   * выручкой периода нельзя ни при каких обстоятельствах.
   */
  obligation: number;
  sessions: number;
  courses: number;
  /** Из них у курсов, выпавших из графика: эти сеансы труднее всего вернуть. */
  atRisk: number;
  atRiskCourses: number;
  /** Сеансы, уже стоящие в расписании: обязательство с назначенной датой. */
  scheduledSessions: number;
}

/**
 * Сколько клиника должна отработать.
 *
 * Число всегда показывается с подписью «обязательства, не выручка». Без неё
 * его складывают с деньгами месяца — и получают выручку, которой не было.
 */
export function outstandingCourseValue(
  courses: CourseFact[],
  now: Date = new Date(),
): OutstandingCourses {
  let obligation = 0;
  let sessions = 0;
  let count = 0;
  let atRisk = 0;
  let atRiskCourses = 0;
  let scheduledSessions = 0;

  for (const c of courses) {
    const left = Math.max(c.sessionsTotal - c.sessionsUsed, 0);
    if (left === 0) continue;
    const money = left * c.pricePerSession;
    obligation += money;
    sessions += left;
    count += 1;
    scheduledSessions += Math.min(c.sessionsBooked, left);

    const last = c.sessionDates[c.sessionDates.length - 1] ?? c.purchasedAt;
    const idle = Math.floor((now.getTime() - last.getTime()) / DAY);
    const stalled =
      !c.hasFuture && c.sessionsBooked === 0 && c.thresholdDays !== null && idle > c.thresholdDays;
    if (stalled) {
      atRisk += money;
      atRiskCourses += 1;
    }
  }

  return { obligation, sessions, courses: count, atRisk, atRiskCourses, scheduledSessions };
}

export interface SessionInterval {
  /** Медиана дней между соседними сеансами. null — сеансов меньше двух. */
  medianDays: number | null;
  meanDays: number | null;
  /** Сколько промежутков посчитано: одному сеансу интервала не отвести. */
  gaps: number;
  /** Самый длинный перерыв — по нему видно, где человек выпадал. */
  maxDays: number | null;
}

/**
 * Как часто пациент ходит на сеансы курса.
 *
 * Медиана, а не среднее: один перерыв на отпуск в три недели сдвигает среднее
 * так, что типичный ритм исчезает. Среднее стоит рядом вторым числом.
 */
export function sessionInterval(sessionDates: Date[]): SessionInterval {
  const ordered = [...sessionDates].sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    gaps.push(Math.round((ordered[i].getTime() - ordered[i - 1].getTime()) / DAY));
  }
  if (gaps.length === 0) {
    return { medianDays: null, meanDays: null, gaps: 0, maxDays: null };
  }
  return {
    medianDays: medianOf(gaps),
    meanDays: gaps.reduce((a, b) => a + b, 0) / gaps.length,
    gaps: gaps.length,
    maxDays: Math.max(...gaps),
  };
}

/** Сколько дней после конца курса ждём повторной покупки. */
export const REPURCHASE_WINDOW_DAYS = 90;

export interface CourseRepurchase {
  /** Курсы, закончившиеся достаточно давно, чтобы судить. */
  cohort: number;
  repurchased: number;
  /** null — судить не по кому: когорта пуста. */
  rate: number | null;
  /**
   * Закончили недавно: окно ожидания ещё не прошло, и в долю они не идут.
   * Иначе каждый свежий месяц показывает ноль возвратов.
   */
  tooEarly: number;
  medianDaysToRepurchase: number | null;
  windowDays: number;
}

export interface RepurchaseInput {
  patientId: string;
  /** Когда закончился курс — дата последнего сеанса. */
  finishedAt: Date;
  /** Даты последующих покупок курсов этим пациентом. */
  laterPurchases: Date[];
}

/**
 * Возвращаются ли за вторым курсом.
 *
 * Считаем по курсам, ЗАКОНЧЕННЫМ достаточно давно: у человека, прошедшего
 * последний сеанс на прошлой неделе, ещё не было времени вернуться, и
 * записывать его в «не вернулся» — это врать про клинику.
 */
export function courseRepurchase(
  inputs: RepurchaseInput[],
  now: Date = new Date(),
  windowDays: number = REPURCHASE_WINDOW_DAYS,
): CourseRepurchase {
  const windowMs = windowDays * DAY;
  let cohort = 0;
  let repurchased = 0;
  let tooEarly = 0;
  const days: number[] = [];

  for (const row of inputs) {
    const elapsed = now.getTime() - row.finishedAt.getTime();
    const next = row.laterPurchases
      .filter((d) => d.getTime() > row.finishedAt.getTime())
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const inWindow = next ? next.getTime() - row.finishedAt.getTime() <= windowMs : false;

    /**
     * Окно ещё не прошло. Купивший внутри него — уже вернувшийся, и прятать
     * его в «рано судить» неправильно: факт состоялся.
     */
    if (elapsed < windowMs && !inWindow) {
      tooEarly += 1;
      continue;
    }

    cohort += 1;
    if (inWindow && next) {
      repurchased += 1;
      days.push(Math.round((next.getTime() - row.finishedAt.getTime()) / DAY));
    }
  }

  return {
    cohort,
    repurchased,
    rate: cohort === 0 ? null : repurchased / cohort,
    tooEarly,
    medianDaysToRepurchase: medianOf(days),
    windowDays,
  };
}
