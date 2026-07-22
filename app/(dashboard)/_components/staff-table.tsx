import { formatMoney, formatMoneyPrecise, formatNumber } from "@/lib/format";
import type { StaffStat } from "@/lib/metrics/types";

/**
 * Приёмы и выручка — двумя независимыми барами, каждый нормирован по своей
 * колонке. Процедурная сестра первая по приёмам и последняя по выручке: это
 * нормальная картина клиники, а не ошибка, и усреднением её не «чинят».
 *
 * Строка с нулевой выручкой остаётся в таблице: пустой трек и `0 ₽` — это
 * тоже показание.
 */
export function StaffTable({ staff }: { staff: StaffStat[] }) {
  if (staff.length === 0) {
    return <p className="text-label text-[11px]">за период приёмов нет</p>;
  }

  return (
    // table-fixed: длинная фамилия не должна съедать колонки с барами.
    <table className="w-full table-fixed border-collapse">
      <thead>
        <tr className="border-groove border-b">
          <th className="legend py-1 pr-3 text-left font-normal">Специалист</th>
          <th className="legend w-[26%] py-1 pr-3 text-left font-normal">Приёмы</th>
          <th className="legend w-[32%] py-1 pr-3 text-left font-normal">Выручка</th>
          <th className="legend hidden w-[14%] py-1 text-right font-normal sm:table-cell">Чек</th>
        </tr>
      </thead>
      <tbody>
        {staff.map((row) => (
          <tr key={row.staffId} className="border-groove border-b last:border-b-0">
            <td className="py-2 pr-3 align-middle">
              {/* Полное имя и специальность — в тултипе: колонка фиксирована,
                  фамилия вроде «Константинопольская-Ржевская» не должна
                  съедать бары. */}
              <p className="truncate text-[13px] leading-tight" title={row.name}>
                {row.name}
              </p>
              <p className="text-label truncate text-[11px] leading-tight" title={row.specialty}>
                {row.specialty}
              </p>
            </td>

            <td className="py-2 pr-3 align-middle">
              <div className="flex items-center gap-2">
                <div className="border-groove bg-panel-sunk hidden h-4 flex-1 border sm:block">
                  <div
                    className="bg-inset border-groove h-full border-r"
                    style={{ width: `${row.appointmentsShare * 100}%` }}
                  />
                </div>
                <span className="num w-10.5 shrink-0 text-right text-[13px]">
                  {formatNumber(row.appointments)}
                </span>
              </div>
            </td>

            <td className="py-2 pr-3 align-middle">
              <div className="flex items-center gap-2">
                <div className="border-groove bg-panel-sunk hidden h-4 flex-1 border sm:block">
                  <div
                    className="bg-inset border-groove h-full border-r"
                    style={{ width: `${row.revenueShare * 100}%` }}
                  />
                </div>
                <span className="num w-21.5 shrink-0 text-right text-[13px]">
                  {formatMoney(row.revenue)}
                </span>
              </div>
            </td>

            <td className="num text-label hidden py-2 text-right align-middle text-[12px] whitespace-nowrap sm:table-cell">
              {row.avgCheck > 0 ? formatMoneyPrecise(row.avgCheck) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
