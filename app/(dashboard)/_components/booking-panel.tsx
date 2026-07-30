"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { addAppt, getDb, useDb } from "@/app/_data/store";
import { formatMinute, freeGaps } from "@/lib/metrics/occupancy";
import { CLINIC_DAY, durationLabel, hasConflict, roomIntervals } from "@/lib/schedule";

/**
 * Панель записи. Свободные окна считаются из ЕДИНОГО источника (стор
 * db.appointments) — те же данные, что на «Сегодня» и «Расписании». Перед
 * созданием слот перепроверяется на занятость (модель «перепроверки в YCLIENTS»,
 * §2): если за время выбора его заняли — запись не создаётся. Успешная запись
 * реально добавляется в стор и появляется в расписании.
 */
type Check = "idle" | "checking" | "created" | "taken";

const ROOM_NAME: Record<string, string> = {
  "room-1": "Кабинет 1 · процедурный",
  "room-2": "Кабинет 2 · БОС",
  "room-3": "Кабинет 3 · остеопат",
};

interface ServiceDef {
  key: string;
  title: string;
  durationMin: number;
  roomId: string;
  doctor: string;
}
const SERVICES: ServiceDef[] = [
  { key: "osteo", title: "Остеопатия, приём", durationMin: 60, roomId: "room-3", doctor: "Левин А." },
  { key: "iv", title: "IV-терапия, капельница", durationMin: 90, roomId: "room-1", doctor: "Соколова Е." },
  { key: "bos", title: "БОС-терапия, сеанс", durationMin: 40, roomId: "room-2", doctor: "Мороз Д." },
  { key: "neuro", title: "Нейромедитация", durationMin: 30, roomId: "room-2", doctor: "Мороз Д." },
  { key: "lab", title: "Забор анализов", durationMin: 15, roomId: "room-1", doctor: "Литвинова О. А." },
];

interface WindowOption {
  id: string;
  roomId: string;
  startMinute: number;
  durationMin: number;
  cab: string;
  dir: string;
  dur: string;
}

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
  const db = useDb();
  const [serviceKey, setServiceKey] = useState<string | null>(null);
  const [windowId, setWindowId] = useState<string | null>(null);
  const [patient, setPatient] = useState("");
  const [check, setCheck] = useState<Check>("idle");
  const [booked, setBooked] = useState<{ time: string; room: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const service = SERVICES.find((s) => s.key === serviceKey) ?? null;

  // Реальные свободные окна выбранной услуги в её кабинете — из стора.
  const windows: WindowOption[] = useMemo(() => {
    if (!service) return [];
    const gaps = freeGaps(roomIntervals(db.appointments, service.roomId), CLINIC_DAY, service.durationMin);
    return gaps.map((g) => ({
      id: `${service.roomId}-${g.startMinute}`,
      roomId: service.roomId,
      startMinute: g.startMinute,
      durationMin: service.durationMin,
      cab: ROOM_NAME[service.roomId],
      dir: service.title.split(",")[0],
      dur: durationLabel(g.durationMin),
    }));
  }, [service, db.appointments]);

  const selected = windows.find((w) => w.id === windowId) ?? null;
  const ready = service && selected && patient.trim().length > 1;

  function verifyAndBook() {
    if (!service || !selected) return;
    setCheck("checking");
    if (timer.current) clearTimeout(timer.current);
    // Перепроверка занятости по свежему состоянию (модель запроса в YCLIENTS).
    timer.current = setTimeout(() => {
      const conflict = hasConflict(
        getDb().appointments,
        selected.roomId,
        selected.startMinute,
        selected.durationMin,
      );
      if (conflict) {
        setCheck("taken");
        return;
      }
      addAppt({
        roomId: selected.roomId,
        roomName: ROOM_NAME[selected.roomId],
        doctor: service.doctor,
        service: service.title,
        patientId: null,
        patientName: patient.trim(),
        startMinute: selected.startMinute,
        durationMin: selected.durationMin,
        status: "planned",
      });
      setBooked({ time: formatMinute(selected.startMinute), room: ROOM_NAME[selected.roomId] });
      setCheck("created");
    }, 700);
  }

  return (
    <div
      className="overlay-scrim fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 py-[6vh] max-md:p-0"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="bg-surface border-border flex max-h-[88vh] w-full max-w-[440px] flex-col rounded-2xl border max-md:h-full max-md:max-h-none max-md:rounded-none"
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
                key={s.key}
                type="button"
                onClick={() => {
                  setServiceKey(s.key);
                  setWindowId(null);
                  setCheck("idle");
                }}
                className={`rounded-md border px-2.5 py-1.5 text-sm ${
                  serviceKey === s.key
                    ? "border-accent-border bg-accent-tint text-accent-text font-medium"
                    : "border-border text-text-muted hover:bg-hover"
                }`}
              >
                {s.title.split(",")[0]}
              </button>
            ))}
          </div>

          <div className="text-text-subtle mt-5 mb-2 text-2xs">
            Свободное окно{service ? ` · ${ROOM_NAME[service.roomId]}` : ""}
          </div>
          {!service ? (
            <p className="text-text-subtle text-sm">Сначала выберите услугу.</p>
          ) : windows.length === 0 ? (
            <p className="text-text-subtle text-sm">
              В {ROOM_NAME[service.roomId]} нет свободного окна на {service.durationMin} мин до конца дня.
            </p>
          ) : (
            <ul className="border-border overflow-hidden rounded-lg border">
              {windows.map((w, i) => {
                const sel = windowId === w.id;
                return (
                  <li key={w.id} className={i > 0 ? "border-border-soft border-t" : undefined}>
                    <button
                      type="button"
                      onClick={() => {
                        setWindowId(w.id);
                        setCheck("idle");
                      }}
                      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left ${
                        sel ? "bg-accent-tint" : "hover:bg-hover"
                      }`}
                    >
                      <span className={`num text-data font-medium ${sel ? "text-accent-text" : "text-text"}`}>
                        {formatMinute(w.startMinute)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{w.cab}</span>
                        <span className="text-text-subtle block truncate text-xs">
                          окно {w.dur}, приём {durationLabel(w.durationMin)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

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
              Слот уже заняли, пока вы выбирали. Возьмите другое окно.
            </p>
          ) : check === "created" ? (
            <p className="text-text-muted mb-2.5 text-sm">
              Запись создана — {booked?.time}, {booked?.room}. Видна в расписании.
            </p>
          ) : (
            <p className="text-text-subtle mb-2.5 text-xs">Перед записью слот перепроверяется на занятость.</p>
          )}
          <button
            type="button"
            disabled={(!ready || check === "checking") && check !== "created"}
            onClick={check === "created" ? onClose : verifyAndBook}
            className="bg-accent text-accent-contrast hover:bg-accent-hover w-full rounded-md py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45"
          >
            {check === "checking"
              ? "Проверяем слот…"
              : check === "created"
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
