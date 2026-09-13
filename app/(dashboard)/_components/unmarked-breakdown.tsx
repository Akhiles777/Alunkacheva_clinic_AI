"use client";

import { useEffect } from "react";
import { visitTitle } from "@/lib/visit-title";
import type { Appt } from "@/app/_data/store";
import type { UnmarkedView } from "./day-facts";

/**
 * Приёмы без отметки — и что про каждый известно.
 *
 * «Не отмечено 2» отвечает «сколько», а заказчик спросил точнее: «может, это
 * те, кто перенёс запись, а может, админ забыл». Это два разных случая с
 * разными действиями — позвонить человеку или попросить проставить отметку, —
 * и держать их в одном числе значит не ответить ни на один.
 *
 * Факт и догадка подписаны по-разному (§9). «Перенесён» — это записанный
 * выгрузкой перенос. «Похоже на перенос» — вывод по тому, что у пациента
 * появилась другая запись уже после пропущенного приёма. У каждой строки
 * написано ЕЁ основание: без него список читается как «система так решила».
 */

const WHEN = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

export function UnmarkedBreakdown({
  appts,
  unmarked,
  dateLabel,
  onClose,
}: {
  /** Те же приёмы, что экран посчитал неотмеченными. */
  appts: Appt[];
  /** Разбор с сервера: приём → что про него известно. */
  unmarked: Record<string, UnmarkedView>;
  dateLabel: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = [...appts].sort((a, b) => a.startMinute - b.startMinute);
  const moved = rows.filter((a) => unmarked[a.id]?.kind === "moved").length;
  const maybe = rows.filter((a) => unmarked[a.id]?.kind === "maybe_moved").length;
  const forgotten = rows.filter((a) => unmarked[a.id]?.kind === "forgotten").length;

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
        aria-label={`Приёмы без отметки за ${dateLabel}`}
        className="border-border bg-surface day-pop relative flex max-h-full w-full max-w-[620px] flex-col overflow-hidden rounded-xl border shadow-lg"
      >
        <div className="border-border flex items-baseline justify-between gap-3 border-b px-5 py-3.5">
          <div>
            <h2 className="text-sm font-medium">Без отметки за {dateLabel}</h2>
            <p className="text-text-subtle mt-0.5 text-2xs">
              всего {rows.length}
              {moved > 0 ? ` · перенесено ${moved}` : ""}
              {maybe > 0 ? ` · похоже на перенос ${maybe}` : ""}
              {forgotten > 0 ? ` · отметку забыли ${forgotten}` : ""}
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

        <ul className="flex-1 overflow-auto">
          {rows.length === 0 ? (
            <li className="text-text-subtle px-5 py-6 text-sm">
              Все приёмы этого дня разобраны.
            </li>
          ) : (
            rows.map((a) => {
              const info = unmarked[a.id];
              return (
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
                    <span className="text-text-subtle block truncate text-2xs">
                      {visitTitle(a.parts, a.service)} · {a.doctor}
                    </span>
                    {/*
                      Основание у каждой строки. «Перенесён» без объяснения
                      читается как решение системы, а решение здесь принимает
                      человек — он звонит пациенту или идёт проставлять отметку.
                    */}
                    <span className="text-text-muted mt-0.5 block text-2xs leading-relaxed">
                      {info?.reason ?? "разбор не загрузился"}
                      {info?.movedTo ? ` → ${WHEN.format(new Date(info.movedTo))}` : ""}
                    </span>
                  </span>
                  <span
                    className={`flex-none text-2xs ${
                      info?.kind === "forgotten" ? "text-accent-text" : "text-text-subtle"
                    }`}
                  >
                    {info?.label ?? "—"}
                  </span>
                </li>
              );
            })
          )}
        </ul>

        <p className="border-border text-text-subtle border-t px-5 py-2.5 text-2xs leading-relaxed">
          Приём, который перенесли правкой записи, уходит с этого дня за три минуты. Перенос
          пересозданием держится до четверти часа — пока не пройдёт полный круг выгрузки.
          Значит строка, висящая дольше получаса без следов переноса, — это непроставленная
          отметка, а не перенос.
        </p>
      </div>
    </div>
  );
}
