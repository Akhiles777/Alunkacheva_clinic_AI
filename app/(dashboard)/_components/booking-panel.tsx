"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Панель записи — оверлей справа поверх любого экрана. Открывается событием
 * `open-booking` от кнопки «+ Запись».
 *
 * Ключевой момент — перед созданием записи слот перепроверяется в YCLIENTS в
 * реальном времени (YCLIENTS — источник истины по расписанию). Здесь это
 * смоделировано состояниями idle → checking → free/taken. Кэш окон только для
 * показа, решение — за свежим ответом YCLIENTS.
 *
 * Форма перемонтируется на каждое открытие (key), состояние сбрасывается без
 * setState-в-эффекте.
 */
type Check = "idle" | "checking" | "free" | "taken";

const SERVICES = ["Остеопатия", "IV-терапия", "БОС-терапия", "Нейромедитация", "Забор анализов"];
const WINDOWS = [
  { id: "w1", time: "13:30", cab: "Кабинет 3", dir: "БОС · нейромедитация", dur: "1 ч 30 мин" },
  { id: "w2", time: "15:00", cab: "Кабинет 1", dir: "Остеопатия", dur: "1 ч" },
  { id: "w3", time: "16:00", cab: "Кабинет 2", dir: "IV-терапия", dur: "1 ч" },
  { id: "w4", time: "16:45", cab: "Кабинет 3", dir: "Нейромедитация", dur: "1 ч 15 мин" },
];

export function BookingButton({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("open-booking"))}
      className={`bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium ${className}`}
    >
      + Запись
    </button>
  );
}

export function BookingPanel() {
  const [open, setOpen] = useState(false);
  const [openCount, setOpenCount] = useState(0);

  useEffect(() => {
    function onOpen() {
      setOpen(true);
      setOpenCount((c) => c + 1);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("open-booking", onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("open-booking", onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!open) return null;
  return <BookingInner key={openCount} onClose={() => setOpen(false)} />;
}

function BookingInner({ onClose }: { onClose: () => void }) {
  const [service, setService] = useState<string | null>(null);
  const [windowId, setWindowId] = useState<string | null>(null);
  const [patient, setPatient] = useState("");
  const [check, setCheck] = useState<Check>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function verifyAndBook() {
    setCheck("checking");
    if (timer.current) clearTimeout(timer.current);
    // Имитация запроса в YCLIENTS. Ближайшее окно чаще перехватывают.
    timer.current = setTimeout(() => {
      const taken = windowId === "w1" && Math.random() < 0.5;
      setCheck(taken ? "taken" : "free");
    }, 1100);
  }

  const ready = service && windowId && patient.trim().length > 1;

  return (
    <div
      className="overlay-scrim fixed inset-0 z-40 flex justify-end"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="bg-surface flex h-full w-full max-w-[420px] flex-col"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Новая запись"
      >
        <div className="border-border flex items-center justify-between border-b px-5 py-4">
          <div className="text-md font-medium">Новая запись</div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-subtle hover:text-text rounded-sm px-1 text-lg leading-none"
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          <div className="text-text-subtle mb-2 text-2xs">Услуга</div>
          <div className="flex flex-wrap gap-1.5">
            {SERVICES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setService(s);
                  setCheck("idle");
                }}
                className={`rounded-md border px-2.5 py-1.5 text-sm ${
                  service === s
                    ? "border-accent-border bg-accent-tint text-accent-text font-medium"
                    : "border-border text-text-muted hover:bg-hover"
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          <div className="text-text-subtle mt-5 mb-2 text-2xs">Свободное окно</div>
          <ul className="border-border overflow-hidden rounded-lg border">
            {WINDOWS.map((w, i) => {
              const selected = windowId === w.id;
              return (
                <li key={w.id} className={i > 0 ? "border-border-soft border-t" : undefined}>
                  <button
                    type="button"
                    onClick={() => {
                      setWindowId(w.id);
                      setCheck("idle");
                    }}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left ${
                      selected ? "bg-accent-tint" : "hover:bg-hover"
                    }`}
                  >
                    <span
                      className={`num text-data font-medium ${selected ? "text-accent-text" : "text-text"}`}
                    >
                      {w.time}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{w.cab}</span>
                      <span className="text-text-subtle block truncate text-xs">{w.dir}</span>
                    </span>
                    <span className="num text-text-subtle text-xs">{w.dur}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="text-text-subtle mt-5 mb-2 text-2xs">Пациент</div>
          <input
            value={patient}
            onChange={(e) => {
              setPatient(e.target.value);
              setCheck("idle");
            }}
            placeholder="Имя или телефон"
            className="border-border-input bg-surface placeholder:text-text-subtle w-full rounded-md border px-3 py-2 text-sm outline-none"
          />
        </div>

        <div className="border-border border-t px-5 py-4">
          {check === "taken" ? (
            <p className="text-accent-text mb-2.5 text-sm">
              Слот уже заняли в YCLIENTS, пока вы выбирали. Возьмите другое окно.
            </p>
          ) : check === "free" ? (
            <p className="text-text-muted mb-2.5 text-sm">Слот свободен — запись создана в YCLIENTS.</p>
          ) : (
            <p className="text-text-subtle mb-2.5 text-xs">
              Перед записью слот перепроверяется в YCLIENTS.
            </p>
          )}
          <button
            type="button"
            disabled={!ready || check === "checking"}
            onClick={verifyAndBook}
            className="bg-accent text-accent-contrast hover:bg-accent-hover w-full rounded-md py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45"
          >
            {check === "checking"
              ? "Проверяем слот в YCLIENTS…"
              : check === "free"
                ? "Готово"
                : check === "taken"
                  ? "Выбрать другое окно"
                  : "Проверить и записать"}
          </button>
        </div>
      </div>
    </div>
  );
}
