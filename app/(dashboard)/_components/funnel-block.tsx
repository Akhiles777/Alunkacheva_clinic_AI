import { formatNumber, formatPercent } from "@/lib/format";
import type { FunnelStep } from "@/lib/metrics/types";

/**
 * Воронка связанным блоком: три отдельных показания не сказали бы главного —
 * где теряются люди. Тихая секция: без акцентного цвета, потери набраны
 * обычной гравировкой, вес несут только цифры (DESIGN.md §5).
 */
export function FunnelBlock({ steps }: { steps: FunnelStep[] }) {
  const [top] = steps;
  const bottom = steps[steps.length - 1];
  const endToEnd = top && top.value > 0 ? bottom.value / top.value : 0;

  return (
    <div>
      <ol>
        {steps.map((step) => (
          <li key={step.key}>
            {/* Пустой период: «не дошли 0 (100%)» — шум, строка убирается. */}
            {step.lostFromPrev && step.lossRateFromPrev !== null ? (
              <div className="text-label flex items-center gap-2 py-1 pl-px text-[11px]">
                <span aria-hidden className="bg-groove h-4 w-px" />
                <span>
                  не дошли{" "}
                  <span className="num text-engrave">{formatNumber(step.lostFromPrev)}</span>{" "}
                  <span className="num">({formatPercent(step.lossRateFromPrev)})</span>
                </span>
              </div>
            ) : (
              <span className="block h-2" />
            )}

            <div className="flex items-baseline gap-3">
              <span className="legend w-21.5 shrink-0">{step.label}</span>
              <div className="border-groove bg-panel-sunk h-6 min-w-px flex-1 border">
                <div
                  className="bg-inset border-groove h-full border-r"
                  style={{ width: `${Math.max(step.shareOfTop * 100, 1)}%` }}
                />
              </div>
              <span className="num w-17 shrink-0 text-right text-[18px] leading-none">
                {formatNumber(step.value)}
              </span>
            </div>
          </li>
        ))}
      </ol>

      <div className="border-groove mt-3 flex items-baseline justify-between gap-3 border-t pt-2">
        <span className="legend">обращение → визит</span>
        <span className="num text-[15px] leading-none">{formatPercent(endToEnd)}</span>
      </div>
    </div>
  );
}
