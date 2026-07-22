import { formatNumber, formatPercent } from "@/lib/format";
import { visitMixShares } from "@/lib/metrics/visits";
import type { VisitMix } from "@/lib/metrics/types";

/**
 * Первичные / повторные одной пропорциональной полосой.
 *
 * Повторные разделены: сеанс курса — не «пациент вернулся», а «идёт по
 * оплаченной программе». Тихая секция — сегменты различаются светлотой и
 * подписью, второго акцента здесь нет.
 */
export function VisitMixBar({ mix }: { mix: VisitMix }) {
  const shares = visitMixShares(mix);

  const segments = [
    { key: "first", label: "Первичные", value: mix.first, share: shares.first, fill: "bg-inset" },
    {
      key: "course",
      label: "Курсовые",
      value: mix.courseSession,
      share: shares.courseSession,
      fill: "bg-panel-sunk",
    },
    {
      key: "return",
      label: "Возвраты",
      value: mix.returned,
      share: shares.returned,
      fill: "bg-panel-deep",
    },
  ];

  if (mix.total === 0) {
    return (
      <div>
        <div className="border-groove bg-panel-sunk h-8 border" />
        <p className="text-label mt-2 text-[11px]">за период визитов нет</p>
      </div>
    );
  }

  return (
    <div>
      <div
        className="border-groove flex h-8 w-full overflow-hidden border"
        role="img"
        aria-label={segments
          .map((segment) => `${segment.label}: ${segment.value}, ${formatPercent(segment.share)}`)
          .join("; ")}
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={`${segment.fill} not-first:border-groove h-full not-first:border-l`}
            style={{ width: `${segment.share * 100}%` }}
          />
        ))}
      </div>

      <dl className="mt-2.5 grid grid-cols-1 gap-x-5 gap-y-1.5 sm:grid-cols-3">
        {segments.map((segment) => (
          <div key={segment.key} className="flex items-baseline gap-2">
            {/* Образец заливки, а не чекбокс: вытянутый прямоугольник. */}
            <span
              aria-hidden
              className={`${segment.fill} border-groove h-2 w-4 shrink-0 border`}
            />
            <dt className="text-label text-[11px]">{segment.label}</dt>
            <dd className="num ml-auto text-[13px]">
              {formatNumber(segment.value)}
              <span className="text-label ml-1.5 text-[11px]">
                {formatPercent(segment.share)}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
