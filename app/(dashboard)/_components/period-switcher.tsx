import Link from "next/link";
import { PERIODS } from "@/lib/mock-metrics";
import type { PeriodKey } from "@/lib/metrics/types";

/**
 * Тумблер периода. Активное положение — утопленный сегмент с сигнальной
 * кромкой снизу: состояние читается формой, а не только цветом (DESIGN.md §2).
 * Период живёт в URL — ссылку можно отправить, переключатель работает без JS.
 */
export function PeriodSwitcher({ active }: { active: PeriodKey }) {
  return (
    <nav aria-label="Период" className="border-groove flex border">
      {PERIODS.map(({ key, label }) => {
        const isActive = key === active;
        return (
          <Link
            key={key}
            href={`/?period=${key}`}
            aria-current={isActive ? "page" : undefined}
            className={`legend relative px-3 py-1.5 not-first:border-groove not-first:border-l ${
              isActive
                ? "bg-inset text-engrave"
                : "bg-panel-sunk text-label hover:bg-inset"
            }`}
          >
            {label}
            {isActive ? (
              <span aria-hidden className="bg-signal absolute inset-x-0 bottom-0 h-0.5" />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
