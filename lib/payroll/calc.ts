/**
 * Расчёт зарплаты сотрудника за период.
 *
 * Правило клиники: медсестра получает 500 ₽ за каждую процедуру **в счёт**
 * почасовой оплаты, а не сверх неё. Администратор выдаёт эти деньги в конце
 * смены, а в конце месяца остаётся доплатить разницу.
 *
 *   начислено = отработанные часы × ставка за час
 *   выдано    = сумма выплат за смены
 *   к выплате = начислено − выдано
 *
 * Именно здесь ошибалась прежняя программа заказчика: она прибавляла выплаты
 * за процедуры к почасовой сумме вместо того, чтобы вычитать их как аванс, —
 * и остаток выходил завышенным.
 *
 * Часы считаем по состоявшимся визитам (ARRIVED): неявка не оплачивается как
 * рабочее время специалиста.
 */

export interface PayrollInput {
  /** Отработанные минуты за период (сумма длительностей состоявшихся визитов). */
  workedMinutes: number;
  /** Ставка за час. */
  hourlyRate: number;
  /** Сколько процедур, за которые платят в смену. */
  procedures: number;
  /** Ставка за процедуру. */
  perProcedureRate: number;
  /**
   * Фактически выданные суммы за период. Если пусто, считаем ожидаемую выдачу
   * как procedures × perProcedureRate — так видно расхождение с фактом.
   */
  paidOut?: number | null;
}

export interface PayrollResult {
  hours: number;
  /** Начислено по часам. */
  accrued: number;
  /** Ожидалось выдать за процедуры. */
  expectedAdvance: number;
  /** Фактически выдано. */
  paidOut: number;
  /** Остаток к выплате. Может быть отрицательным — тогда выдали лишнее. */
  remainder: number;
  /** Расхождение факта выдачи с ожидаемым: помогает найти забытую выдачу. */
  advanceMismatch: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function calcPayroll(input: PayrollInput): PayrollResult {
  const hours = round2(Math.max(0, input.workedMinutes) / 60);
  const accrued = round2(hours * Math.max(0, input.hourlyRate));
  const expectedAdvance = round2(Math.max(0, input.procedures) * Math.max(0, input.perProcedureRate));
  const paidOut = round2(input.paidOut ?? expectedAdvance);

  return {
    hours,
    accrued,
    expectedAdvance,
    paidOut,
    remainder: round2(accrued - paidOut),
    advanceMismatch: round2(paidOut - expectedAdvance),
  };
}
