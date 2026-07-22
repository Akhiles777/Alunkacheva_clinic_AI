import { formatNumber, formatPercent } from "@/lib/format";
import type { SourceStat } from "@/lib/metrics/types";

/**
 * Обращения по источникам. Бар нормирован по максимуму, а не по сумме.
 * Тихая секция: плоская заливка вставки на дне паза, без цвета.
 */
export function SourceBars({ sources }: { sources: SourceStat[] }) {
  if (sources.length === 0) {
    return <p className="text-label text-[11px]">за период обращений нет</p>;
  }

  return (
    // Две колонки только на широком экране: в узкой секции трек бара
    // схлопывается до нечитаемой полоски.
    <ul className="space-y-2 xl:grid xl:grid-cols-2 xl:gap-x-10 xl:gap-y-2 xl:space-y-0">
      {sources.map((source) => {
        const conversion = source.inquiries === 0 ? 0 : source.booked / source.inquiries;

        return (
          <li key={source.code} className="grid grid-cols-[minmax(0,92px)_minmax(0,1fr)] items-center gap-3">
            <span className="truncate text-[12px]">{source.title}</span>
            <div className="flex items-center gap-2.5">
              <div className="border-groove bg-panel-sunk h-5 min-w-16 flex-1 border">
                <div
                  className="bg-inset border-groove h-full border-r"
                  style={{ width: `${Math.max(source.share * 100, 1)}%` }}
                />
              </div>
              <span className="num w-9.5 shrink-0 text-right text-[13px]">
                {formatNumber(source.inquiries)}
              </span>
              <span className="num text-label w-16 shrink-0 text-right text-[11px]">
                {formatNumber(source.booked)} · {formatPercent(conversion)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
