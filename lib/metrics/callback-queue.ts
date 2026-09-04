/**
 * Кому позвонить сегодня.
 *
 * Рабочая очередь администратора: люди, до которых клиника не дозвонилась
 * сама. Четыре повода, и у каждой строки на экране написано ЕЁ основание —
 * список без основания превращается в «система так решила», и по нему
 * перестают звонить.
 *
 * Пороги берутся из настроек услуги (`Service.stalledAfterDays`), а не из
 * констант в коде: БОС-терапию ходят раз в неделю, остеопатию — раз в месяц,
 * и одно число на всех означало бы, что половину зовут рано, а половину
 * поздно. Порога у услуги нет — пациент в очередь по этому поводу не идёт
 * вовсе, и число таких случаев экран называет вслух. Придумать порог за
 * клинику мы не вправе.
 *
 * Из списка человека убирает ТОЛЬКО настоящая будущая запись. Не отправленное
 * сообщение, не «я ему написала» — запись. Иначе очередь становится списком
 * добрых намерений: написали и забыли, а пациент не пришёл.
 */

export type CandidateKind = "COURSE_STALLED" | "COURSE_FINISHING" | "NO_SHOW" | "SLEEPING";

/**
 * Что это за деньги.
 *
 * PREPAID — клиника их уже получила, а сеансы не отработала: обязательство.
 * POTENTIAL — цена услуги по прайсу: это план, а не деньги (§8). Складывать
 * их в одно число нельзя, поэтому в строке написано, какие они.
 */
export type MoneyKind = "PREPAID" | "POTENTIAL";

/**
 * Чей порог сработал.
 *
 * «Порог услуги 14 дн.» и «запасной порог клиники 14 дн.» — разные
 * утверждения: первое клиника сказала про эту услугу, второе — про всё
 * сразу. Администратор должен видеть, на чём основан звонок.
 */
export type ThresholdSource = "SERVICE" | "CLINIC";

const THRESHOLD_LABEL: Record<ThresholdSource, string> = {
  SERVICE: "порог услуги",
  CLINIC: "запасной порог клиники",
};

export interface QueueCourse {
  courseId: string;
  title: string;
  total: number;
  /** Состоявшиеся сеансы. */
  used: number;
  /** Записанные вперёд — место занято, но приём ещё не прошёл. */
  booked: number;
  pricePerSession: number;
  lastSessionAt: Date | null;
  /** Порог: сколько дней без сеанса означает «выпал». */
  thresholdDays: number | null;
  /** Чей это порог — услуги или запасной клиники. Это разные утверждения. */
  thresholdFrom: ThresholdSource;
}

export interface QueueInput {
  patientId: string;
  patientName: string;
  /** Единственное, что убирает из очереди. */
  hasFutureBooking: boolean;
  lastVisitAt: Date | null;
  lastVisitTitle: string | null;
  /** Порог по услуге последнего визита или запасной клиники. */
  thresholdDays: number | null;
  thresholdFrom: ThresholdSource;
  /** Цена услуги по прайсу — план, а не выручка. */
  servicePrice: number | null;
  noShowAt: Date | null;
  noShowTitle: string | null;
  courses: QueueCourse[];
}

export interface QueueRow {
  patientId: string;
  patientName: string;
  kind: CandidateKind;
  /** Почему человек в списке — то, что читает администратор перед звонком. */
  basis: string;
  money: number | null;
  moneyKind: MoneyKind;
  /** Сколько дней прошло с события, давшего основание. */
  days: number | null;
  courseId: string | null;
}

export interface QueueReport {
  rows: QueueRow[];
  /**
   * Сколько человек не попало в очередь только потому, что у их услуги не
   * задан порог. Это не ноль кандидатов — это незаполненная настройка, и
   * молчать о ней нельзя: экран выглядел бы пустым при полной базе.
   */
  withoutThreshold: number;
}

const DAY_MS = 24 * 3600 * 1000;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/** «24 дня назад» / «сегодня» — так, как это произносит администратор. */
function ago(days: number): string {
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  return `${days} дн. назад`;
}

/** Сколько сеансов ещё нужно записать: оплаченные минус пройденные и занятые. */
export function sessionsToBook(course: QueueCourse): number {
  return Math.max(course.total - course.used - course.booked, 0);
}

/**
 * Курс на финише: осталось дозаписать один-два сеанса.
 *
 * Считается по НЕзаписанным: у пациента, чьи оставшиеся приёмы уже стоят в
 * расписании, звать некого. Это та же ошибка, что была на экране курсов.
 */
export const FINISHING_LEFT = 2;

/**
 * Один человек — одна строка.
 *
 * Звонят человеку, а не поводу: две строки про одного пациента означают два
 * звонка об одном и том же. Повод берётся сильнейший, а в основании
 * перечислено всё, что важно сказать.
 */
const PRIORITY: CandidateKind[] = ["COURSE_STALLED", "NO_SHOW", "COURSE_FINISHING", "SLEEPING"];

function candidatesFor(input: QueueInput, now: Date): QueueRow[] {
  const rows: QueueRow[] = [];

  for (const c of input.courses) {
    const toBook = sessionsToBook(c);
    if (toBook === 0) continue;

    const progress = `сеанс ${c.used} из ${c.total}`;
    const money = (c.total - c.used) * c.pricePerSession;
    const days = c.lastSessionAt ? daysBetween(c.lastSessionAt, now) : null;

    /**
     * Выпал из курса: порог услуги пройден, а будущей записи нет. Деньги за
     * эти сеансы клиника УЖЕ получила — это обязательство, а не потенциал.
     */
    if (c.thresholdDays !== null && days !== null && days > c.thresholdDays) {
      rows.push({
        patientId: input.patientId,
        patientName: input.patientName,
        kind: "COURSE_STALLED",
        basis: `${c.title} · ${progress} · последний сеанс ${ago(days)} · ${THRESHOLD_LABEL[c.thresholdFrom]} ${c.thresholdDays} дн. · будущих записей нет`,
        money,
        moneyKind: "PREPAID",
        days,
        courseId: c.courseId,
      });
      continue;
    }

    /**
     * На финише: сеансы кончаются, и о продолжении говорят заранее. Порог
     * здесь ни при чём — дело в остатке, а не в паузе.
     */
    if (toBook <= FINISHING_LEFT) {
      rows.push({
        patientId: input.patientId,
        patientName: input.patientName,
        kind: "COURSE_FINISHING",
        basis: `${c.title} · ${progress} · дозаписать осталось ${toBook}${
          days === null ? "" : ` · последний сеанс ${ago(days)}`
        }`,
        money,
        moneyKind: "PREPAID",
        days,
        courseId: c.courseId,
      });
    }
  }

  /**
   * Не пришёл и не перезаписан. Держим повод, пока не прошёл порог услуги:
   * дальше это уже не «не пришёл на той неделе», а «давно не был», и звать
   * надо другими словами.
   */
  if (input.noShowAt) {
    const days = daysBetween(input.noShowAt, now);
    const within = input.thresholdDays === null || days <= input.thresholdDays;
    if (within) {
      rows.push({
        patientId: input.patientId,
        patientName: input.patientName,
        kind: "NO_SHOW",
        basis: `не пришёл ${ago(days)}${input.noShowTitle ? ` · ${input.noShowTitle}` : ""} · не перезаписан`,
        money: input.servicePrice,
        moneyKind: "POTENTIAL",
        days,
        courseId: null,
      });
    }
  }

  /**
   * Спящий: давно не был, курса нет, записи нет. Порог — из услуги, которой
   * он ходил: у остеопатии и у капельниц он разный.
   */
  if (input.lastVisitAt && input.thresholdDays !== null && input.courses.length === 0) {
    const days = daysBetween(input.lastVisitAt, now);
    if (days > input.thresholdDays) {
      rows.push({
        patientId: input.patientId,
        patientName: input.patientName,
        kind: "SLEEPING",
        basis: `последний визит ${ago(days)}${
          input.lastVisitTitle ? ` · ${input.lastVisitTitle}` : ""
        } · ${THRESHOLD_LABEL[input.thresholdFrom]} ${input.thresholdDays} дн.`,
        money: input.servicePrice,
        moneyKind: "POTENTIAL",
        days,
        courseId: null,
      });
    }
  }

  return rows;
}

/**
 * Собрать очередь.
 *
 * Сортировка — по деньгам: сверху то, что дороже потерять. Строки без суммы
 * идут в конец и подписаны «сумма неизвестна» — ноль вместо неизвестной цены
 * отправил бы их в самый низ как заведомо ненужные.
 */
export function buildQueue(inputs: QueueInput[], now: Date = new Date()): QueueReport {
  const rows: QueueRow[] = [];
  let withoutThreshold = 0;

  for (const input of inputs) {
    // Настоящая будущая запись — единственное, что снимает человека с очереди.
    if (input.hasFutureBooking) continue;

    const found = candidatesFor(input, now);
    if (found.length === 0) {
      /**
       * Порога нет — и мы молчим о человеке, хотя он, возможно, кандидат.
       * Это незаполненная настройка, а не отсутствие работы, и число таких
       * случаев должно быть видно.
       */
      const couldBeStalled =
        input.courses.some((c) => c.thresholdDays === null && sessionsToBook(c) > 0) ||
        (input.courses.length === 0 && input.lastVisitAt !== null && input.thresholdDays === null);
      if (couldBeStalled) withoutThreshold += 1;
      continue;
    }

    const best = found.sort(
      (a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind),
    )[0];
    rows.push(best);
  }

  rows.sort((a, b) => {
    const am = a.money ?? -1;
    const bm = b.money ?? -1;
    return bm - am || (b.days ?? 0) - (a.days ?? 0) || a.patientId.localeCompare(b.patientId);
  });

  return { rows, withoutThreshold };
}
