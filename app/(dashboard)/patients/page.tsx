"use client";

import { useMemo, useState } from "react";
import { patientTags, primaryPhone, searchPatients, useDb, type Patient } from "@/app/_data/store";
import { PatientsAnalytics } from "./patients-analytics";
import { AddPatientModal } from "./add-patient-modal";
import { PatientModal } from "./patient-modal";

const FILTERS = [
  { id: "all", label: "Все" },
  { id: "new", label: "Новые" },
  { id: "course", label: "На курсе" },
  { id: "stalled", label: "Выпали из курса" },
  { id: "noconsent", label: "Без согласия" },
];

function matchesFilter(p: Patient, filter: string): boolean {
  const tags = patientTags(p);
  if (filter === "all") return true;
  if (filter === "new") return tags.includes("первичный");
  if (filter === "course") return tags.includes("на курсе");
  if (filter === "stalled") return tags.includes("выпал из курса");
  if (filter === "noconsent") return tags.includes("без согласия");
  return true;
}

export default function PatientsPage() {
  const db = useDb();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const rows = useMemo(
    () => searchPatients(query, db.patients).filter((p) => matchesFilter(p, filter)),
    [query, filter, db.patients],
  );

  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Пациенты</h1>
          <div className="flex items-center gap-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Имя или телефон"
              className="border-border-input bg-surface placeholder:text-text-subtle w-[220px] rounded-md border px-3 py-2 text-sm outline-none max-md:w-32"
            />
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3.5 py-2 text-sm font-medium whitespace-nowrap"
            >
              + Пациент
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <PatientsAnalytics />

        <div className="mt-7">
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`rounded-md px-2.5 py-1 text-xs ${
                  filter === f.id ? "bg-nav-active text-accent-text font-medium" : "text-text-muted hover:bg-hover"
                }`}
              >
                {f.label}
              </button>
            ))}
            <span className="num text-text-subtle ml-auto self-center text-xs">
              {rows.length} из {db.patients.length}
            </span>
          </div>

          {rows.length === 0 ? (
            <p className="text-text-muted text-sm">
              Никого не нашли. Проверьте номер или имя, смените фильтр — или добавьте пациента.
            </p>
          ) : (
            <div className="border-border overflow-hidden rounded-xl border">
              <table className="w-full table-fixed border-collapse">
                <thead>
                  <tr className="border-border bg-surface border-b text-left">
                    <th className="text-text-subtle px-4 py-2.5 text-2xs font-normal">Пациент</th>
                    <th className="text-text-subtle w-[30%] px-4 py-2.5 text-2xs font-normal max-md:hidden">Метки</th>
                    <th className="text-text-subtle w-[20%] px-4 py-2.5 text-2xs font-normal max-md:hidden">Источник</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const tags = patientTags(p);
                    return (
                      <tr
                        key={p.id}
                        onClick={() => setSelected(p.id)}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") setSelected(p.id);
                        }}
                        className="border-border-soft hover:bg-hover cursor-pointer border-b last:border-b-0"
                      >
                        <td className="px-4 py-3 align-middle">
                          <div className="truncate text-sm font-medium" title={p.name}>
                            {p.name}
                          </div>
                          <div className="num text-text-subtle text-xs">
                            {primaryPhone(p)?.pretty ?? "нет номера"}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-middle max-md:hidden">
                          <div className="flex flex-wrap gap-1">
                            {tags.length === 0 ? (
                              <span className="text-text-subtle text-xs">—</span>
                            ) : (
                              tags.map((t) => (
                                <span key={t} className="text-text-muted bg-chip rounded-sm px-2 py-0.5 text-2xs">
                                  {t}
                                </span>
                              ))
                            )}
                          </div>
                        </td>
                        <td className="text-text-muted px-4 py-3 align-middle text-sm max-md:hidden">{p.source}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <AddPatientModal open={adding} onClose={() => setAdding(false)} onCreated={(id) => setSelected(id)} />
      {selected ? <PatientModal patientId={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}
