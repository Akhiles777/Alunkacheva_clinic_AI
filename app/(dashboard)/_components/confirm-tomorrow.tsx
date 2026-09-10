"use client";

import { useEffect, useState } from "react";
import { confirmListAction, markContacted, type ConfirmRow } from "./no-show-actions";

/**
 * «Стоит подтвердить» — записи на завтра, к которым лучше позвонить.
 *
 * Прогноз ничего не блокирует и ни на что не влияет: он только собирает в одно
 * место то, что администратор и так делает по чутью, — и называет основание,
 * чтобы решение оставалось за ним. Пометки «73%» здесь нет намеренно: процент
 * создаёт впечатление точности, которой у правил нет.
 *
 * Блока не видно вовсе, пока веса не утверждены и пока подтверждать нечего:
 * пустой раздел на главном экране читается как сломанный.
 */
export function ConfirmTomorrow() {
  const [rows, setRows] = useState<ConfirmRow[] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void confirmListAction()
      .then((res) => alive && setRows(res))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, []);

  if (!rows || rows.length === 0) return null;

  return (
    <section className="mt-[26px]">
      <div className="mb-[13px] flex flex-wrap items-baseline gap-2.5">
        <h2 className="text-base font-medium">Стоит подтвердить</h2>
        <span className="num text-text-subtle text-xs">{rows.length} на завтра</span>
        <span className="text-text-subtle text-xs">
          пометка ничего не блокирует — рядом написано, почему она стоит
        </span>
      </div>
      {note ? <p className="text-text-muted mb-2 text-xs">{note}</p> : null}
      <ul className="border-border bg-surface divide-border-soft divide-y rounded-xl border">
        {rows.map((r) => (
          <li key={r.appointmentId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
            <span className="num text-text-muted flex-none text-xs">{r.at}</span>
            <span className="text-sm font-medium">{r.patientName}</span>
            <span className="text-text-muted text-xs">{r.title}</span>
            {/* Основание: без него список читается как «система так решила». */}
            <span className="text-text-subtle text-xs">{r.reasons.join(" · ")}</span>
            <a
              href={`/inbox?d=${encodeURIComponent(r.dialogId ?? "")}`}
              onClick={(e) => {
                if (!r.dialogId) {
                  e.preventDefault();
                  setNote(`${r.patientName}: переписки нет — позвоните по телефону из карточки.`);
                  return;
                }
                void markContacted(r.appointmentId);
              }}
              className="text-accent-text ml-auto flex-none text-xs hover:underline"
            >
              Написать
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
