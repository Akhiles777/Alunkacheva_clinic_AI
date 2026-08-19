"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Выбор дня календарём.
 *
 * Здесь стояло системное поле `<input type="date">`. Оно выглядит по-разному в
 * каждом браузере, не подчиняется палитре и на десктопе открывается крохотным
 * окном с иконкой часов — в рабочем инструменте, где день переключают
 * десятки раз за смену, это раздражает.
 *
 * Даты — строки «ГГГГ-ММ-ДД» в поясе клиники. Сетку строим арифметикой по UTC:
 * если считать локальным временем браузера, у пользователя в другом поясе
 * месяц начинался бы не с того числа.
 */
const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

const key = (y: number, m: number, d: number): string =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Понедельник — первый: у Date воскресенье нулевое, и сетка съезжала. */
function leadingBlanks(y: number, m: number): number {
  return (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

export interface DayPickerProps {
  /** Выбранный день, «2026-08-19». */
  value: string;
  /** Самый ранний доступный день включительно. */
  min: string;
  /** Самый поздний доступный день включительно. */
  max: string;
  onPick: (day: string) => void;
  /** Подпись на кнопке: «19 августа, среда». */
  label: string;
}

export function DayPicker({ value, min, max, onPick, label }: DayPickerProps) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => Number(value.slice(0, 4)));
  const [month, setMonth] = useState(() => Number(value.slice(5, 7)) - 1);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const total = daysInMonth(year, month);
  const blanks = leadingBlanks(year, month);
  const step = (delta: number) => {
    const m = month + delta;
    if (m < 0) {
      setYear((y) => y - 1);
      setMonth(11);
    } else if (m > 11) {
      setYear((y) => y + 1);
      setMonth(0);
    } else {
      setMonth(m);
    }
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => {
          // Открыли — показываем месяц выбранного дня, а не тот, где
          // остановились в прошлый раз. Делаем это здесь, а не эффектом:
          // состояние, выставленное в теле эффекта, вызывает лишний прогон
          // рендера, и календарь мигал бы чужим месяцем.
          if (!open) {
            setYear(Number(value.slice(0, 4)));
            setMonth(Number(value.slice(5, 7)) - 1);
          }
          setOpen((v) => !v);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="text-text-muted hover:bg-list-gap hover:text-text rounded-full px-2.5 py-1 text-xs transition-colors"
      >
        {label}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Выбор дня"
          className="border-border bg-surface day-pop absolute top-full left-0 z-30 mt-2 w-[252px] rounded-xl border p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Предыдущий месяц"
              className="text-text-muted hover:bg-list-gap hover:text-text flex size-6 items-center justify-center rounded-md transition-colors"
            >
              ‹
            </button>
            <span className="text-sm font-medium">
              {MONTHS[month]} {year}
            </span>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Следующий месяц"
              className="text-text-muted hover:bg-list-gap hover:text-text flex size-6 items-center justify-center rounded-md transition-colors"
            >
              ›
            </button>
          </div>

          <div className="text-text-subtle mb-1 grid grid-cols-7 gap-0.5 text-center text-2xs">
            {WEEKDAYS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {Array.from({ length: blanks }, (_, i) => (
              <span key={`b-${i}`} />
            ))}
            {Array.from({ length: total }, (_, i) => {
              const day = key(year, month, i + 1);
              const disabled = day < min || day > max;
              const selected = day === value;
              return (
                <button
                  key={day}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onPick(day);
                    setOpen(false);
                  }}
                  className={`num flex h-7 items-center justify-center rounded-md text-xs transition-colors ${
                    selected
                      ? "bg-accent text-accent-contrast font-medium"
                      : disabled
                        ? "text-text-subtle opacity-30"
                        : "text-text-muted hover:bg-list-gap hover:text-text"
                  }`}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => {
              onPick(max);
              setOpen(false);
            }}
            className="text-accent-text hover:bg-accent-tint mt-2 w-full rounded-md py-1.5 text-xs transition-colors"
          >
            Сегодня
          </button>
        </div>
      ) : null}
    </div>
  );
}
