"use client";

import { useMemo, useState } from "react";
import type { AuditDisplayRow } from "./actions";

export function AuditClient({ rows }: { rows: AuditDisplayRow[] }) {
  const actors = useMemo(() => ["Все", ...new Set(rows.map((r) => r.actor))], [rows]);
  const [actor, setActor] = useState("Все");
  const [query, setQuery] = useState("");

  const filtered = rows.filter((r) => {
    if (actor !== "Все" && r.actor !== actor) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      r.action.toLowerCase().includes(q) ||
      r.target.toLowerCase().includes(q) ||
      r.at.toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex max-w-[820px] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          className="border-border-input bg-surface rounded-md border px-2.5 py-2 text-sm outline-none"
        >
          {actors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Действие, объект или дата"
          className="border-border-input bg-surface placeholder:text-text-subtle w-[280px] max-w-full rounded-md border px-3 py-2 text-sm outline-none"
        />
        <span className="num text-text-subtle ml-auto text-xs">
          {filtered.length} из {rows.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-text-muted text-sm">Записей не найдено.</p>
      ) : (
        <div className="border-border overflow-hidden rounded-xl border">
          {/* Таблица шире телефона: прокручиваем её саму, а не всю страницу. */}
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-border bg-surface border-b text-left">
                  <th className="text-text-subtle px-4 py-2.5 text-2xs font-normal">Когда</th>
                  <th className="text-text-subtle px-4 py-2.5 text-2xs font-normal">Сотрудник</th>
                  <th className="text-text-subtle px-4 py-2.5 text-2xs font-normal">Действие</th>
                  <th className="text-text-subtle px-4 py-2.5 text-2xs font-normal">Объект</th>
                  <th className="text-text-subtle px-4 py-2.5 text-2xs font-normal">Откуда</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-border-soft border-b last:border-b-0">
                    <td className="num text-text-muted px-4 py-2.5 whitespace-nowrap">{r.at}</td>
                    <td className="px-4 py-2.5">{r.actor}</td>
                    <td className="px-4 py-2.5">{r.action}</td>
                    <td className="text-text-muted px-4 py-2.5">{r.target}</td>
                    <td className="text-text-subtle px-4 py-2.5 whitespace-nowrap">
                      {r.device}
                      {r.ip !== "—" ? <span className="num ml-2 text-2xs">{r.ip}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
