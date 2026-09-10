"use client";

import { useEffect, useState } from "react";
import { visitTitle } from "@/lib/visit-title";
import { formatMoney } from "@/lib/format";
import type { Appt } from "@/app/_data/store";

/**
 * Кто пришёл: поимённо и по услугам.
 *
 * «Первичных 3, повторных 11» отвечает на вопрос «сколько», но следующий
 * вопрос всегда «кто именно и на что» — и до сих пор ответ приходилось искать
 * другим экраном. Список открывается нажатием на само число и показывает тот
 * же день и те же визиты, что стоят над ним.
 *
 * Фильтр устроен как в разборе выручки: одна кнопка — один срез. Считать
 * первичность здесь нельзя, её ставит выгрузка по факту прихода (§8), поэтому
 * мы только раскладываем то, что уже посчитано в шапке.
 */

export type VisitFilter = "all" | "first" | "repeat";

const LABEL: Record<VisitFilter, string> = {
  all: "все",
  first: "первичные",
  repeat: "повторные",
};

export function VisitsBreakdown({
  appts,
  dateLabel,
  initial = "all",
  onClose,
}: {
  appts: Appt[];
  dateLabel: string;
  initial?: VisitFilter;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<VisitFilter>(initial);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * Только СОСТОЯВШИЕСЯ приёмы — те же, из которых считаются числа в шапке.
   * Первичность у не пришедшего человека не определена (§8), и попади он в
   * список, срез «повторные» молча вобрал бы его в себя.
   */
  const arrived = appts
    .filter((a) => a.status === "arrived")
    .sort((a, b) => a.startMinute - b.startMinute);

  const first = arrived.filter((a) => a.isFirstVisit);
  const repeat = arrived.filter((a) => !a.isFirstVisit);
  const shown = filter === "first" ? first : filter === "repeat" ? repeat : arrived;

  const counts: Record<VisitFilter, number> = {
    all: arrived.length,
    first: first.length,
    repeat: repeat.length,
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center p-4 sm:p-8">
      <button
        type="button"
        aria-label="Закрыть"
        onClick={onClose}
        className="overlay-scrim absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-label={`Кто пришёл за ${dateLabel}`}
        className="border-border bg-surface day-pop relative flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-xl border shadow-lg"
      >
        <div className="border-border flex items-baseline justify-between gap-3 border-b px-5 py-3.5">
          <div>
            <h2 className="text-sm font-medium">Кто пришёл за {dateLabel}</h2>
            <p className="text-text-subtle mt-0.5 text-2xs">
              состоявшихся приёмов {arrived.length} · первичных {first.length} · повторных{" "}
              {repeat.length}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text flex-none text-sm"
          >
            ✕
          </button>
        </div>

        <div className="border-border-soft flex flex-wrap gap-1.5 border-b px-5 py-2.5">
          {(["all", "first", "repeat"] as VisitFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={
                filter === f
                  ? "bg-accent text-accent-contrast rounded-md px-2.5 py-1 text-2xs font-medium"
                  : "border-border text-text-muted hover:bg-hover rounded-md border px-2.5 py-1 text-2xs"
              }
            >
              {LABEL[f]} {counts[f]}
            </button>
          ))}
        </div>

        <ul className="flex-1 overflow-auto">
          {shown.length === 0 ? (
            <li className="text-text-subtle px-5 py-6 text-sm">
              {arrived.length === 0
                ? "Состоявшихся приёмов за этот день не было."
                : `Таких приёмов за этот день не было: ${LABEL[filter]}.`}
            </li>
          ) : (
            shown.map((a) => (
              <li
                key={a.id}
                className="border-border-soft flex items-baseline gap-3 border-b px-5 py-2.5 last:border-0"
              >
                <span className="num text-text-subtle w-11 flex-none text-xs">
                  {String(Math.floor(a.startMinute / 60)).padStart(2, "0")}:
                  {String(a.startMinute % 60).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{a.patientName}</span>
                  {/*
                    Имя визита — это его состав: у записи бывает несколько
                    услуг, и первая из них не отвечает на вопрос «на что
                    пришёл» (§8).
                  */}
                  <span className="text-text-subtle block truncate text-2xs">
                    {visitTitle(a.parts, a.service)} · {a.doctor}
                  </span>
                </span>
                {/* Срез «все» смешивает оба вида, и там подпись обязательна. */}
                {filter === "all" ? (
                  <span className="text-text-subtle flex-none text-2xs">
                    {a.isFirstVisit ? "первичный" : "повторный"}
                  </span>
                ) : null}
                <span className="num text-text-muted flex-none text-xs">
                  {formatMoney(a.price ?? 0)}
                </span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
