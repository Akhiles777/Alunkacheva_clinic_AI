"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PATIENTS, type Patient } from "@/app/_data/patients";

/**
 * Глобальный поиск ⌘K — несущая конструкция по IA: пациент достаётся из любой
 * точки. Открывается по ⌘K / Ctrl+K и по событию `open-command` из поля-триггера
 * в шапке. Принимает имя и цифры телефона.
 *
 * Внутренняя форма перемонтируется на каждое открытие (key), поэтому состояние
 * сбрасывается без setState-в-эффекте.
 */
function search(query: string): Patient[] {
  const q = query.trim().toLowerCase();
  if (!q) return PATIENTS.slice(0, 5);
  const digits = q.replace(/\D/g, "");
  return PATIENTS.filter((p) => {
    const nameHit = p.name.toLowerCase().includes(q);
    const phoneHit = digits.length >= 2 && p.phone.replace(/\D/g, "").includes(digits);
    return nameHit || phoneHit;
  });
}

export function CommandPalette() {
  const [openCount, setOpenCount] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setOpenCount((c) => c + 1);
      }
      if (e.key === "Escape") setOpen(false);
    }
    function onOpen() {
      setOpen(true);
      setOpenCount((c) => c + 1);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command", onOpen);
    };
  }, []);

  if (!open) return null;
  return <PaletteInner key={openCount} onClose={() => setOpen(false)} />;
}

function PaletteInner({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => search(query), [query]);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, []);

  function choose(patient: Patient) {
    onClose();
    router.push(`/patients/${patient.id}`);
  }

  return (
    <div
      className="overlay-scrim fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="border-border bg-surface w-full max-w-[560px] overflow-hidden rounded-xl border"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Поиск"
      >
        <div className="border-border-soft flex items-center gap-3 border-b px-4 py-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && results[active]) {
                choose(results[active]);
              }
            }}
            placeholder="Пациент, телефон или номер записи"
            className="text-base placeholder:text-text-subtle w-full border-none bg-transparent outline-none"
          />
          <kbd className="num text-text-subtle border-border rounded-sm border px-1.5 py-0.5 text-2xs">
            esc
          </kbd>
        </div>

        <ul className="max-h-[52vh] overflow-auto p-1.5">
          {results.length === 0 ? (
            <li className="text-text-muted px-3 py-6 text-center text-sm">
              Ничего не нашлось. Проверьте номер или имя.
            </li>
          ) : (
            results.map((patient, index) => (
              <li key={patient.id}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(patient)}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left ${
                    index === active ? "bg-hover" : ""
                  }`}
                >
                  <span className="bg-ink-avatar text-text-muted flex h-8 w-8 flex-none items-center justify-center rounded-full text-2xs font-medium">
                    {patient.name
                      .split(" ")
                      .slice(0, 2)
                      .map((w) => w[0])
                      .join("")}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{patient.name}</span>
                    <span className="num text-text-subtle block text-xs">
                      {patient.phonePretty}
                    </span>
                  </span>
                  {patient.tags[0] ? (
                    <span className="text-text-subtle bg-chip rounded-sm px-2 py-0.5 text-2xs">
                      {patient.tags[0]}
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

/** Поле в шапке экрана — открывает палитру. Выглядит как input, но это кнопка. */
export function SearchTrigger({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("open-command"))}
      className={`border-border-input bg-surface text-text-subtle hover:border-border-strong flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${className}`}
    >
      <span className="flex-1 truncate">Поиск пациента или телефона</span>
      <kbd className="num border-border rounded-sm border px-1.5 py-px text-2xs">⌘K</kbd>
    </button>
  );
}
