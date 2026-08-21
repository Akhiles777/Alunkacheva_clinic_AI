import type { SourceStat, StaffStat } from "./types";

/**
 * Средний чек = деньги / те, кто эти деньги принёс.
 *
 * Знаменатель — оплаченные чеки, а не все пришедшие. День клиники выглядит
 * так: десять приёмов, из них восемь — сеансы курсов по нулю (деньги за них
 * получены в день продажи) и один бесплатный приём сотруднику. Деля выручку
 * на всех пришедших, экран показывал средний чек 300 ₽ там, где реально
 * заплативший пациент оставил три тысячи. Такое число ничего не измеряет:
 * оно падает ровно тогда, когда клиника ведёт больше курсовых сеансов.
 *
 * Поэтому в знаменатель идут только приёмы с суммой плюс проданные в этот
 * период курсы: у продажи есть клиент и сумма, это полноценный чек. Сеанс
 * курса и бесплатный приём не считаются ни в числителе, ни в знаменателе
 * (решение заказчика, август 2026).
 */
export function averageCheck(revenue: number, paying: number): number {
  if (paying <= 0) return 0;
  return Math.round((revenue / paying) * 100) / 100;
}

/**
 * Доля неявок в процентах.
 *
 * Знаменатель — только состоявшиеся исходы: пришёл или не пришёл. Запланированный
 * на следующую неделю визит неявкой ещё быть не мог, и в знаменателе он только
 * разбавляет показатель. Отменённые тоже не в счёт: отмена — это не неявка, за
 * неё пациент предупредил.
 *
 * Функция одна на всю систему. Прежде кабинет владельца делил неявки на все
 * незаменённые визиты, а карточка специалиста — на состоявшиеся исходы: под
 * одной подписью «Неявки» стояли разные числа, и по ним нельзя было ни
 * сравнить специалистов, ни поговорить с ними.
 */
export function noShowRate(arrived: number, noShow: number): number {
  const settled = arrived + noShow;
  if (settled <= 0) return 0;
  return Math.round((noShow / settled) * 100);
}

/**
 * Доли для баров: каждая колонка нормируется по своему максимуму.
 * Приёмы и выручка не сводятся к одному бару — процедурная сестра лидирует
 * по количеству и последняя по выручке, это нормальная картина, а не ошибка.
 */
export function withStaffShares(
  rows: Omit<StaffStat, "appointmentsShare" | "revenueShare" | "avgCheck">[],
): StaffStat[] {
  const maxAppointments = Math.max(0, ...rows.map((row) => row.appointments));
  const maxRevenue = Math.max(0, ...rows.map((row) => row.revenue));

  return rows.map((row) => ({
    ...row,
    avgCheck: averageCheck(row.revenue, row.paying),
    appointmentsShare: maxAppointments === 0 ? 0 : row.appointments / maxAppointments,
    revenueShare: maxRevenue === 0 ? 0 : row.revenue / maxRevenue,
  }));
}

/** Бары по источникам нормируются по максимуму, а не по сумме. */
export function withSourceShares(rows: Omit<SourceStat, "share">[]): SourceStat[] {
  const max = Math.max(0, ...rows.map((row) => row.inquiries));
  return rows
    .map((row) => ({ ...row, share: max === 0 ? 0 : row.inquiries / max }))
    .sort((a, b) => b.inquiries - a.inquiries);
}
