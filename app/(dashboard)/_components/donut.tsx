import { formatNumber, formatPercent } from "@/lib/format";

/**
 * Долевая диаграмма — доли одного целого.
 *
 * Кольцо, а не столбики: вопрос здесь «какая часть», а не «сколько». В центре
 * стоит итог, чтобы доли было от чего отсчитывать.
 *
 * Палитра одна и акцентная (DESIGN.md): разные цвета читались бы как разные
 * сущности, а это части одного. Различает их сила тона — от акцента к
 * нейтрали, — и ступень назначается по величине доли: самая крупная всегда
 * самая тёмная. Так диаграмма читается и без легенды, и в чёрно-белой печати.
 *
 * Ноль не рисуется. Пустое кольцо с подписью «0%» — утверждение, которого мы
 * не делали: доля неизвестна, а не равна нулю.
 */

export interface DonutSlice {
  label: string;
  value: number;
  /** Пояснение под строкой легенды — то, что число означает. */
  hint?: string;
}

const STEPS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

/** Точка на окружности по доле от начала (12 часов), радиус 1. */
function point(share: number, r: number): [number, number] {
  const angle = 2 * Math.PI * share - Math.PI / 2;
  return [Math.cos(angle) * r, Math.sin(angle) * r];
}

export function Donut({
  slices,
  total,
  totalLabel,
  empty = "данных за период нет",
}: {
  slices: DonutSlice[];
  /** Итог в центре. По умолчанию — сумма долей. */
  total?: number;
  totalLabel?: string;
  empty?: string;
}) {
  const shown = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const sum = shown.reduce((s, x) => s + x.value, 0);
  const middle = total ?? sum;

  if (sum === 0) {
    return <p className="text-text-muted text-sm">{empty}</p>;
  }

  const R = 1;
  const INNER = 0.62;

  /**
   * Границы дуг считаем заранее, а не накапливаем по ходу отрисовки: правило
   * React — не менять переменные во время рендера, иначе повторный проход
   * (а он бывает) выдаёт другую картинку.
   */
  const arcs: { slice: DonutSlice; from: number; to: number }[] = [];
  let running = 0;
  for (const s of shown) {
    const from = running;
    running += s.value / sum;
    arcs.push({ slice: s, from, to: running });
  }

  return (
    <div className="flex items-center gap-5 max-sm:flex-col max-sm:items-start">
      <svg
        viewBox="-1.05 -1.05 2.1 2.1"
        className="h-[128px] w-[128px] flex-none max-sm:h-[104px] max-sm:w-[104px]"
        role="img"
        aria-label={shown.map((s) => `${s.label}: ${s.value}`).join(", ")}
      >
        {arcs.map(({ slice: s, from, to }, i) => {
          const share = to - from;
          /**
           * Одна доля на всё — кольцо целиком. Дуга в 360° вырождается: точка
           * начала совпадает с точкой конца, и путь схлопывается в ничто.
           */
          if (share >= 0.999) {
            return (
              <circle
                key={s.label}
                cx="0"
                cy="0"
                r={(R + INNER) / 2}
                fill="none"
                stroke={STEPS[i % STEPS.length]}
                strokeWidth={R - INNER}
              />
            );
          }
          const [x1, y1] = point(from, R);
          const [x2, y2] = point(to, R);
          const [x3, y3] = point(to, INNER);
          const [x4, y4] = point(from, INNER);
          const large = share > 0.5 ? 1 : 0;
          return (
            <path
              key={s.label}
              d={`M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${INNER} ${INNER} 0 ${large} 0 ${x4} ${y4} Z`}
              fill={STEPS[i % STEPS.length]}
            />
          );
        })}
        <text
          x="0"
          y="0.02"
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-[var(--text)]"
          style={{ fontSize: 0.32, fontWeight: 500 }}
        >
          {formatNumber(middle)}
        </text>
        {totalLabel ? (
          <text
            x="0"
            y="0.3"
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-[var(--text-subtle)]"
            style={{ fontSize: 0.14 }}
          >
            {totalLabel}
          </text>
        ) : null}
      </svg>

      <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
        {shown.map((s, i) => (
          <li key={s.label} className="flex items-baseline gap-2">
            <span
              aria-hidden
              className="mt-1 h-2 w-2 flex-none rounded-[2px]"
              style={{ background: STEPS[i % STEPS.length] }}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs">{s.label}</span>
              {s.hint ? <span className="text-text-subtle block text-2xs">{s.hint}</span> : null}
            </span>
            <span className="num text-text-subtle flex-none text-2xs">
              {formatNumber(s.value)} · {formatPercent(s.value / sum)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
