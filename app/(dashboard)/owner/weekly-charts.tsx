"use client";

import { useState } from "react";
import Link from "next/link";
import { formatMoney, formatMoneyPrecise } from "@/lib/format";
import { averageCheck } from "@/lib/metrics/summary";
import type { WeeklyDynamics, WeekPoint } from "./actions";

/**
 * Динамика по неделям для владельца: доход, клиенты и средний чек.
 *
 * Три отдельные панели, а не один график с двумя осями: величины разного
 * масштаба на общей шкале врут. Значение подписано только у максимума и у
 * последней недели — цифра над каждым столбиком превращает график в таблицу.
 * Таблица тоже есть, переключателем: она же и доступная версия.
 */

type Measure = {
  key: string;
  title: string;
  value: (w: WeekPoint) => number;
  format: (n: number) => string;
  hint: string;
};

const MEASURES: Measure[] = [
  { key: "revenue", title: "Доход", value: (w) => w.revenue, format: (n) => formatMoney(n), hint: "за неделю" },
  { key: "clients", title: "Клиенты", value: (w) => w.clients, format: (n) => String(n), hint: "уникальных" },
  {
    key: "avg",
    title: "Средний чек",
    /**
     * Той же функцией, что и в отчётах.
     *
     * Здесь считалось «доход ÷ клиенты», а в отчётах — «выручка ÷ приёмы».
     * Пациент, пришедший за неделю трижды, в одном месте один, в другом три:
     * два разных числа под одной подписью «средний чек», и владелец
     * справедливо считал это ошибкой платформы.
     *
     * Знаменатель — оплаченные чеки: приёмы с суммой плюс проданные курсы.
     */
    value: (w) => averageCheck(w.revenue, w.paying),
    // Формат тот же, что в отчётах: округление до рубля здесь и до копейки
    // там дало бы «4 475 ₽» против «4 475,11 ₽» под одной подписью.
    format: (n) => formatMoneyPrecise(n),
    hint: "деньги ÷ оплаченные чеки",
  },
];

function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function DeltaBadge({ pct, title }: { pct: number | null; title?: string }) {
  if (pct === null) return <span className="text-text-subtle text-2xs">нет базы</span>;
  const up = pct >= 0;
  return (
    <span
      title={title}
      className={`num rounded-md px-1.5 py-0.5 text-2xs font-medium ${
        up ? "bg-accent-tint text-accent-text" : "bg-chip text-text-muted"
      }`}
    >
      <span aria-hidden>{up ? "▲" : "▼"}</span> {up ? "+" : ""}
      {pct}%
    </span>
  );
}

function Panel({ measure, weeks }: { measure: Measure; weeks: WeekPoint[] }) {
  const values = weeks.map(measure.value);
  const max = Math.max(1, ...values);
  const maxIndex = values.indexOf(max);
  const lastIndex = values.length - 1;
  const last = values[lastIndex] ?? 0;
  const prev = values[lastIndex - 1] ?? 0;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{measure.title}</div>
          <div className="text-text-subtle text-2xs">{measure.hint}</div>
        </div>
        <DeltaBadge pct={deltaPct(last, prev)} title="последняя неделя к предыдущей" />
      </div>

      <div className="readout mt-2 text-lg">{measure.format(last)}</div>

      <div className="mt-3 flex h-[104px] items-end gap-[3px]">
        {weeks.map((w, i) => {
          const v = values[i];
          const heightPct = Math.max(3, Math.round((v / max) * 100));
          const isLast = i === lastIndex;
          const labelled = i === maxIndex || isLast;
          const d = i > 0 ? deltaPct(v, values[i - 1]) : null;
          return (
            // h-full обязателен: без него у колонки авто-высота и процентная
            // высота столбика схлопывается в ноль. Слот подписи занимает место
            // всегда, чтобы базовые линии всех панелей совпадали.
            /*
              Столбец — ссылка на отчёт ровно за эту неделю. Иначе сравнить
              график с отчётом нельзя: они считали разные отрезки, и два числа
              под словом «неделя» выглядели ошибкой платформы.
            */
            <Link
              key={w.label}
              href={`/analytics?period=${w.key}`}
              title={`Отчёты за ${w.label}`}
              className="group relative flex h-full min-w-0 flex-1 flex-col"
            >
              <div className="text-text-muted h-3.5 truncate text-center text-[10px] leading-none">
                {labelled ? measure.format(v) : ""}
              </div>
              <div className="flex min-h-0 flex-1 items-end">
                <div
                  style={{ height: `${heightPct}%` }}
                  className={`w-full rounded-t ${isLast ? "bg-accent" : "bg-accent-border"} group-hover:bg-accent`}
                />
              </div>
              {/* Ховер: неделя, значение и изменение к предыдущей. */}
              <div className="border-border bg-surface pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md border px-2 py-1 text-center whitespace-nowrap group-hover:block">
                <div className="text-text-subtle text-[10px]">неделя {w.label}</div>
                <div className="num text-xs">{measure.format(v)}</div>
                {d !== null ? (
                  <div className="text-text-subtle num text-[10px]">
                    {d >= 0 ? "+" : ""}
                    {d}% к пред.
                  </div>
                ) : null}
              </div>
            </Link>
          );
        })}
      </div>

      <div className="border-border-soft mt-1 flex gap-[3px] border-t pt-1">
        {weeks.map((w) => (
          <div key={w.label} className="text-text-subtle min-w-0 flex-1 truncate text-center text-[10px]">
            {w.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function Table({ weeks }: { weeks: WeekPoint[] }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[420px] border-collapse text-sm">
        <thead>
          <tr className="text-text-subtle text-left text-2xs">
            <th className="py-2 pr-3 font-normal">Неделя</th>
            <th className="py-2 pr-3 text-right font-normal">Доход</th>
            <th className="py-2 pr-3 text-right font-normal">Клиенты</th>
            <th className="py-2 pr-3 text-right font-normal">Приёмы</th>
            <th className="py-2 text-right font-normal">Средний чек</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w.label} className="border-border-soft border-t">
              <td className="num py-2 pr-3">{w.label}</td>
              <td className="num py-2 pr-3 text-right">{formatMoney(w.revenue)}</td>
              <td className="num py-2 pr-3 text-right">{w.clients}</td>
              <td className="num py-2 pr-3 text-right">{w.appts}</td>
              <td className="num py-2 text-right">
                {formatMoney(w.clients > 0 ? Math.round(w.revenue / w.clients) : 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WeeklyCharts({ data }: { data: WeeklyDynamics }) {
  const [view, setView] = useState<"chart" | "table">("chart");

  if (data.weeks.length === 0) {
    return (
      <section className="border-border bg-surface rounded-xl border p-5">
        <h2 className="text-sm font-medium">Динамика по неделям</h2>
        <p className="text-text-subtle mt-2 text-sm">
          Пока недостаточно данных за прошлые недели. Панель заполнится, как только закроется первая полная неделя
          с визитами в статусе «пришёл».
        </p>
      </section>
    );
  }

  return (
    <section className="border-border bg-surface rounded-xl border p-5">
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-sm font-medium">Динамика по неделям</h2>
        <span className="text-text-subtle text-xs">
          {data.weeks.length} полных недель · текущая неделя не учитывается
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-text-subtle text-2xs">за период:</span>
          <DeltaBadge pct={data.revenueGrowthPct} title="доход: последняя неделя к первой" />
          <DeltaBadge pct={data.clientsGrowthPct} title="клиенты: последняя неделя к первой" />
          <button
            type="button"
            onClick={() => setView((v) => (v === "chart" ? "table" : "chart"))}
            className="border-border text-text-muted hover:bg-hover ml-1 rounded-md border px-2 py-1 text-2xs"
          >
            {view === "chart" ? "таблицей" : "графиком"}
          </button>
        </div>
      </div>

      {view === "chart" ? (
        <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-3">
          {MEASURES.map((m) => (
            <Panel key={m.key} measure={m} weeks={data.weeks} />
          ))}
        </div>
      ) : (
        <Table weeks={data.weeks} />
      )}
    </section>
  );
}
