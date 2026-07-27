"use client";

import { useMemo, useState } from "react";
import { PATIENTS, searchPatients, type Patient } from "@/app/_data/patients";
import { PatientOverlay } from "../_components/patient-overlay";

const FILTERS = [
  { id: "all", label: "Все" },
  { id: "new", label: "Новые" },
  { id: "course", label: "На курсе" },
  { id: "stalled", label: "Выпали из курса" },
];

function matchesFilter(p: Patient, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "new") return p.firstSeen === "сегодня" || p.tags.includes("первичный");
  if (filter === "course") return p.courses.some((c) => c.status === "active");
  if (filter === "stalled") return p.courses.some((c) => c.status === "stalled");
  return true;
}

export default function PatientsPage() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<Patient | null>(null);

  const rows = useMemo(
    () => searchPatients(query).filter((p) => matchesFilter(p, filter)),
    [query, filter],
  );

  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Пациенты</h1>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Имя или телефон"
            className="border-border-input bg-surface placeholder:text-text-subtle w-[260px] rounded-md border px-3 py-2 text-sm outline-none max-md:w-40"
          />
        </div>
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`rounded-md px-2.5 py-1 text-xs ${
                filter === f.id
                  ? "bg-nav-active text-accent-text font-medium"
                  : "text-text-muted hover:bg-hover"
              }`}
            >
              {f.label}
            </button>
          ))}
          <span className="num text-text-subtle ml-auto self-center text-xs">
            {rows.length} из {PATIENTS.length}
          </span>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-7 py-5 max-md:px-5">
        {rows.length === 0 ? (
          <p className="text-text-muted text-sm">
            Никого не нашли. Проверьте номер или имя, либо смените фильтр.
          </p>
        ) : (
          <div className="border-border overflow-hidden rounded-xl border">
            <table className="w-full table-fixed border-collapse">
              <thead>
                <tr className="border-border bg-surface border-b text-left">
                  <th className="text-text-subtle px-4 py-2.5 text-2xs font-normal">Пациент</th>
                  <th className="text-text-subtle w-[26%] px-4 py-2.5 text-2xs font-normal max-md:hidden">
                    Статус
                  </th>
                  <th className="text-text-subtle w-[22%] px-4 py-2.5 text-2xs font-normal max-md:hidden">
                    Источник
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => setSelected(p)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setSelected(p);
                    }}
                    className="border-border-soft hover:bg-hover cursor-pointer border-b last:border-b-0"
                  >
                    <td className="px-4 py-3 align-middle">
                      <div className="truncate text-sm font-medium" title={p.name}>
                        {p.name}
                      </div>
                      <div className="num text-text-subtle text-xs">{p.phonePretty}</div>
                    </td>
                    <td className="px-4 py-3 align-middle max-md:hidden">
                      {p.tags[0] ? (
                        <span className="text-text-muted bg-chip rounded-sm px-2 py-0.5 text-2xs">
                          {p.tags[0]}
                        </span>
                      ) : (
                        <span className="text-text-subtle text-xs">—</span>
                      )}
                    </td>
                    <td className="text-text-muted px-4 py-3 align-middle text-sm max-md:hidden">
                      {p.source}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected ? <PatientOverlay patient={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}
