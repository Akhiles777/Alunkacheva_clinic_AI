"use client";

import { useState } from "react";
import type { FreeWindowRow } from "@/app/_data/today";
import { WindowOfferPanel } from "./window-offer";

/**
 * Единый список свободных окон по всем кабинетам до конца дня, по времени.
 * Ближайшее — заливка сплошным акцентом: «когда ближайшее окно» читается без
 * чтения списка. Строки разделены фоном-щелью, не рамкой. Строка кликабельна —
 * ведёт к записи в это окно.
 */
export function FreeWindows({ windows }: { windows: FreeWindowRow[] }) {
  /**
   * Нажатие на окно показывает, КОГО туда позвать, а не открывает пустую
   * форму записи: список кандидатов и свободные окна администратор до сих пор
   * соединял в голове. Записать оттуда можно тем же жестом, что и раньше.
   */
  const [chosen, setChosen] = useState<FreeWindowRow | null>(null);

  if (windows.length === 0) {
    return (
      <div className="border-border bg-surface rounded-xl border px-4 py-6">
        <p className="text-text-muted text-sm">
          До конца дня свободных окон нет — все три кабинета заняты.
        </p>
      </div>
    );
  }

  return (
    <>
    {chosen ? (
      <WindowOfferPanel
        roomId={chosen.roomId}
        startAtIso={chosen.startAtIso}
        durationMin={chosen.durationMin}
        label={`${chosen.time} · ${chosen.cabName} · ${chosen.duration}`}
        onClose={() => setChosen(null)}
      />
    ) : null}
    <div className="bg-list-gap border-border flex flex-col gap-px overflow-hidden rounded-xl border">
      {windows.map((w) => (
        <button
          key={w.id}
          type="button"
          onClick={() => setChosen(w)}
          className={`flex items-center gap-5 px-[18px] py-[13px] text-left ${
            w.soon ? "bg-accent-tint" : "bg-surface hover:bg-hover"
          }`}
        >
          <span
            className={`num text-data w-[84px] flex-none font-medium tracking-[-0.02em] ${
              w.soon ? "text-accent-text" : "text-text"
            }`}
          >
            {w.time}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={`block truncate text-sm font-medium ${w.soon ? "text-accent-text" : "text-text"}`}
            >
              {w.cabName}
            </span>
            <span className="text-text-subtle block truncate text-xs">{w.direction}</span>
          </span>
          <span
            className={`num rounded-pill border px-3 py-1 text-xs font-medium whitespace-nowrap ${
              w.soon
                ? "border-accent bg-accent text-accent-contrast"
                : "border-accent-border bg-accent-tint text-accent-text"
            }`}
          >
            {w.duration}
          </span>
        </button>
      ))}
    </div>
    </>
  );
}
