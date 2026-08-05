"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Поле с поиском по списку: ввод сверху, совпадения списком под ним.
 *
 * Один компонент на выбор пациента и выбор специалиста. Оба случая устроены
 * одинаково — «начни печатать, выбери из базы», — и разводить их в два разных
 * поведения нельзя: администратор работает быстро и не должен помнить, где
 * список выпадает, а где нет.
 *
 * Выбранное значение показываем строкой с крестиком, а не оставляем в поле
 * ввода: иначе непонятно, выбран человек из базы или просто набран текст. Это
 * различие важное — от него зависит, свяжется запись с карточкой или заведёт
 * новую.
 */
export interface PickerItem {
  id: string;
  title: string;
  /** Вторая строка: телефон, специальность, число визитов. */
  subtitle?: string | null;
}

export function Picker({
  label,
  placeholder,
  items,
  selected,
  query,
  onQuery,
  onSelect,
  onClear,
  loading = false,
  emptyHint,
  footer,
}: {
  label: string;
  placeholder: string;
  items: PickerItem[];
  selected: PickerItem | null;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (item: PickerItem) => void;
  onClear: () => void;
  loading?: boolean;
  emptyHint?: string;
  /** Действие под списком — например, «завести нового пациента». */
  footer?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  if (selected) {
    return (
      <div>
        <div className="text-text-subtle mt-5 mb-2 text-2xs">{label}</div>
        <div className="border-accent-border bg-accent-tint flex items-center gap-3 rounded-md border px-3 py-2">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{selected.title}</span>
            {selected.subtitle ? (
              <span className="text-text-muted block truncate text-xs">{selected.subtitle}</span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={onClear}
            aria-label="Выбрать другого"
            className="text-text-subtle hover:text-text flex-none text-sm"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={box}>
      <div className="text-text-subtle mt-5 mb-2 text-2xs">{label}</div>
      <input
        value={query}
        onChange={(e) => {
          onQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="border-border-input bg-surface placeholder:text-text-subtle w-full rounded-md border px-3 py-2 text-sm outline-none"
      />

      {open ? (
        <div className="border-border mt-1.5 overflow-hidden rounded-lg border">
          {loading ? (
            <p className="text-text-subtle px-3 py-2.5 text-sm">Ищем…</p>
          ) : items.length === 0 ? (
            <p className="text-text-subtle px-3 py-2.5 text-sm">{emptyHint ?? "Ничего не найдено"}</p>
          ) : (
            <ul className="max-h-52 overflow-auto">
              {items.map((item, i) => (
                <li key={item.id} className={i > 0 ? "border-border-soft border-t" : undefined}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(item);
                      setOpen(false);
                    }}
                    className="hover:bg-hover flex w-full flex-col items-start px-3 py-2 text-left"
                  >
                    <span className="truncate text-sm">{item.title}</span>
                    {item.subtitle ? (
                      <span className="text-text-subtle truncate text-xs">{item.subtitle}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {footer ? <div className="border-border-soft border-t">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
