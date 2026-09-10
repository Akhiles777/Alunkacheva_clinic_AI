"use client";

import { useEffect } from "react";
import type { MoveView } from "./day-facts";

/**
 * Кто перенёс запись и на какую дату.
 *
 * YCLIENTS о переносах не сообщает: он показывает запись в её текущем виде, и
 * прошлого времени там нет. Поэтому перенос замечает выгрузка в момент, когда
 * он происходит, — и число здесь копится со дня, когда эта возможность
 * появилась. Про прошлое мы честно молчим, а не показываем ноль.
 *
 * Два вида переносов подписаны по-разному. Время изменили у той же записи —
 * это факт. Запись удалили и завели заново — это вывод, и такой перенос
 * помечен «похоже на перенос»: догадка не подаётся как факт (§9).
 */

const WHEN = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

export function MovesBreakdown({
  moves,
  dateLabel,
  since,
  onClose,
}: {
  moves: MoveView[];
  dateLabel: string;
  since: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const derived = moves.filter((m) => !m.exact).length;

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
        aria-label={`Переносы за ${dateLabel}`}
        className="border-border bg-surface day-pop relative flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-xl border shadow-lg"
      >
        <div className="border-border flex items-baseline justify-between gap-3 border-b px-5 py-3.5">
          <div>
            <h2 className="text-sm font-medium">Переносы за {dateLabel}</h2>
            <p className="text-text-subtle mt-0.5 text-2xs">
              всего {moves.length}
              {derived > 0 ? ` · из них выведено из пересоздания ${derived}` : ""}
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
          {moves.length === 0 ? (
            <li className="text-text-subtle px-5 py-6 text-sm">
              Переносов за этот день не замечено.
            </li>
          ) : (
            moves.map((m) => (
              <li
                key={m.id}
                className="border-border-soft flex items-baseline gap-3 border-b px-5 py-2.5 last:border-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{m.patientName}</span>
                  <span className="text-text-subtle block truncate text-2xs">{m.service}</span>
                </span>
                <span className="flex-none text-right">
                  <span className="num text-text-subtle block text-2xs line-through">
                    {WHEN.format(new Date(m.fromAt))}
                  </span>
                  <span className="num block text-xs">{WHEN.format(new Date(m.toAt))}</span>
                </span>
                {!m.exact ? (
                  <span
                    className="text-text-subtle flex-none text-2xs"
                    title="Запись удалили и завели заново. Это вывод по совпадению пациента и времени создания, а не запись о переносе."
                  >
                    похоже на перенос
                  </span>
                ) : null}
              </li>
            ))
          )}
        </ul>

        {/*
          Без этой строки ноль читается как «не переносят», хотя означает
          «замечать было нечем». Та же ошибка, что структурный ноль на экране.
        */}
        <p className="border-border text-text-subtle border-t px-5 py-2.5 text-2xs leading-relaxed">
          {since === null
            ? "Счёт переносов ещё не начинался: их замечает выгрузка, а прошлые восстановить неоткуда — YCLIENTS о переносах не сообщает."
            : `Счёт ведётся с ${WHEN.format(new Date(since))}. До этого переносы не записывались, а не отсутствовали.`}
        </p>
      </div>
    </div>
  );
}
