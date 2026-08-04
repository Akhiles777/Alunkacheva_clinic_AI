"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { VisitNote } from "../_components/visit-note";
import {
  getDb,
  markArrived,
  markNoShow,
  rescheduleAppt,
  useDb,
  type Appt,
} from "@/app/_data/store";
import { formatMinute } from "@/lib/metrics/occupancy";
import { dateLabelInTz, hasConflict } from "@/lib/schedule";

const ROOMS = [
  { id: "room-1", name: "Кабинет 1 · процедурный" },
  { id: "room-2", name: "Кабинет 2 · БОС" },
  { id: "room-3", name: "Кабинет 3 · остеопат" },
];
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

const STATUS: Record<Appt["status"], { label: string; cls: string }> = {
  planned: { label: "запланирован", cls: "text-text-subtle" },
  confirmed: { label: "подтверждён", cls: "text-text-muted" },
  arrived: { label: "пришёл", cls: "text-text-muted" },
  no_show: { label: "не пришёл", cls: "text-accent-text" },
};

function ApptCard({ appt }: { appt: Appt }) {
  const [editing, setEditing] = useState(false);
  const [time, setTime] = useState(formatMinute(appt.startMinute));
  const [error, setError] = useState<string | null>(null);

  function commitTime() {
    const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    if (!m || Number(m[1]) >= 24 || Number(m[2]) >= 60) {
      setError("Неверное время");
      return;
    }
    const start = Number(m[1]) * 60 + Number(m[2]);
    // Нельзя перенести на занятое время того же кабинета (кроме себя).
    if (hasConflict(getDb().appointments, appt.roomId, start, appt.durationMin, appt.id)) {
      setError("В это время кабинет занят");
      return;
    }
    rescheduleAppt(appt.id, start);
    setError(null);
    setEditing(false);
  }

  const done = appt.status === "arrived" || appt.status === "no_show";

  return (
    <div className="border-border-soft rounded-lg border px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        {editing ? (
          <input
            autoFocus
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
              setError(null);
            }}
            onBlur={commitTime}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTime();
            }}
            className={`bg-surface num w-16 rounded-md border px-1.5 py-0.5 text-sm outline-none ${
              error ? "border-accent-text" : "border-border-input"
            }`}
          />
        ) : (
          <span className={`num text-sm font-medium ${appt.status === "no_show" ? "line-through" : ""}`}>
            {formatMinute(appt.startMinute)}
          </span>
        )}
        {appt.isFirstVisit ? (
          <span aria-hidden className="bg-accent h-1.5 w-1.5 flex-none rounded-[2px]" title="первичный" />
        ) : null}
        <span className={`ml-auto text-2xs ${STATUS[appt.status].cls}`}>{STATUS[appt.status].label}</span>
      </div>
      {error ? <div className="text-accent-text mt-1 text-2xs">{error}</div> : null}
      <div className="mt-1 truncate text-sm">
        {appt.patientId ? (
          <Link href={`/patients/${appt.patientId}`} className="hover:underline">
            {appt.patientName}
          </Link>
        ) : (
          appt.patientName
        )}
      </div>
      <div className="text-text-subtle truncate text-xs">
        {appt.service} · {appt.doctor}
      </div>
      <VisitNote appt={appt} />
      {appt.bookedByName ? (
        // Кто записал, если на приём придёт другой человек: администратору
        // нужно знать, кому звонить при переносе.
        <div className="text-text-subtle truncate text-2xs">записал(а): {appt.bookedByName}</div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {!done ? (
          <>
            <button
              type="button"
              onClick={() => markArrived(appt.id)}
              className="border-border text-text-muted hover:bg-hover rounded-md border px-2 py-1 text-2xs"
            >
              Пришёл
            </button>
            <button
              type="button"
              onClick={() => markNoShow(appt.id)}
              className="border-border text-text-muted hover:bg-hover rounded-md border px-2 py-1 text-2xs"
            >
              Не пришёл
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setTime(formatMinute(appt.startMinute));
            setEditing(true);
          }}
          className="text-text-subtle hover:text-text px-1 py-1 text-2xs"
        >
          Перенести
        </button>
      </div>
    </div>
  );
}

export default function SchedulePage() {
  const db = useDb();
  const [view, setView] = useState<"day" | "week">("day");
  const [room, setRoom] = useState("all");
  const [doctor, setDoctor] = useState("all");

  const doctors = useMemo(
    () => ["all", ...new Set(db.appointments.map((a) => a.doctor))],
    [db.appointments],
  );

  const filtered = db.appointments.filter(
    (a) => (room === "all" || a.roomId === room) && (doctor === "all" || a.doctor === doctor),
  );

  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Расписание</h1>
            <p className="text-text-muted text-xs">{dateLabelInTz()}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="border-border inline-flex overflow-hidden rounded-md border">
              {(["day", "week"] as const).map((v, i) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`px-3 py-1.5 text-sm ${i > 0 ? "border-border border-l" : ""} ${
                    view === v ? "bg-accent-tint text-accent-text font-medium" : "text-text-muted hover:bg-hover"
                  }`}
                >
                  {v === "day" ? "День" : "Неделя"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event("open-booking"))}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3.5 py-2 text-sm font-medium"
            >
              + Запись
            </button>
          </div>
        </div>
        {view === "day" ? (
          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <select
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              className="border-border-input bg-surface rounded-md border px-2.5 py-1.5 text-sm outline-none"
            >
              <option value="all">Все кабинеты</option>
              {ROOMS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <select
              value={doctor}
              onChange={(e) => setDoctor(e.target.value)}
              className="border-border-input bg-surface rounded-md border px-2.5 py-1.5 text-sm outline-none"
            >
              {doctors.map((d) => (
                <option key={d} value={d}>
                  {d === "all" ? "Все специалисты" : d}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </header>

      <div className="flex-1 overflow-auto px-7 py-5 max-md:px-5">
        {view === "day" ? (
          <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-1">
            {ROOMS.filter((r) => room === "all" || r.id === room).map((r) => {
              const appts = filtered
                .filter((a) => a.roomId === r.id)
                .sort((a, b) => a.startMinute - b.startMinute);
              return (
                <section key={r.id}>
                  <div className="mb-2.5 flex items-baseline justify-between">
                    <h2 className="text-sm font-medium">{r.name}</h2>
                    <span className="num text-text-subtle text-xs">{appts.length}</span>
                  </div>
                  {appts.length === 0 ? (
                    <p className="text-text-subtle text-xs">Записей нет.</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {appts.map((a) => (
                        <ApptCard key={a.id} appt={a} />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-7 gap-2 max-md:grid-cols-2">
            {WEEKDAYS.map((wd, i) => {
              // В моке заполнен только четверг (индекс 3); остальные — иллюстративно.
              const isToday = i === 3;
              const count = isToday ? db.appointments.length : [4, 6, 5, 0, 7, 3, 0][i];
              return (
                <button
                  key={wd}
                  type="button"
                  onClick={() => setView("day")}
                  className={`border-border rounded-lg border px-3 py-3 text-left ${
                    isToday ? "bg-accent-tint border-accent-border" : "hover:bg-hover"
                  }`}
                >
                  <div className={`text-sm font-medium ${isToday ? "text-accent-text" : ""}`}>{wd}</div>
                  <div className="num text-text-subtle mt-1 text-xs">{23 - 3 + i} июля</div>
                  <div className="num mt-3 text-xl leading-none">{count}</div>
                  <div className="text-text-subtle text-2xs">записей</div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
