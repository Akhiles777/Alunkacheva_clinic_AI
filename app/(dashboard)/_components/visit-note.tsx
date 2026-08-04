"use client";

import { useState } from "react";
import { setApptNote, type Appt } from "@/app/_data/store";

/**
 * Заметка по состоявшемуся визиту: отзыв пациента, замечание, что пошло не так.
 *
 * Появляется только после приёма — до него писать нечего. Текст попадает в
 * контекст ИИ-аналитика владельца, поэтому это не «комментарий в никуда», а
 * вход для разбора: жалобы и повторяющиеся замечания видны в отчёте.
 *
 * Поле свободное и необязательное: заставлять врача заполнять его после
 * каждого приёма — верный способ получить «ок» в каждой строке.
 */
export function VisitNote({ appt }: { appt: Appt }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(appt.note ?? "");
  const [saved, setSaved] = useState(false);

  if (appt.status !== "arrived" && appt.status !== "no_show") return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-accent-text mt-1.5 text-2xs hover:underline"
      >
        {appt.note ? "Заметка: изменить" : "+ Отзыв или заметка"}
      </button>
    );
  }

  return (
    <div className="mt-1.5">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        rows={2}
        placeholder="Отзыв пациента, замечание, что учесть в следующий раз…"
        className="border-border-input bg-surface placeholder:text-text-subtle w-full resize-y rounded-md border px-2.5 py-1.5 text-xs outline-none"
      />
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setApptNote(appt.id, text);
            setSaved(true);
            setOpen(false);
          }}
          className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-2.5 py-1 text-2xs font-medium"
        >
          Сохранить
        </button>
        <button
          type="button"
          onClick={() => {
            setText(appt.note ?? "");
            setOpen(false);
          }}
          className="text-text-subtle hover:text-text text-2xs"
        >
          Отмена
        </button>
        {saved ? <span className="text-text-muted text-2xs">сохранено</span> : null}
      </div>
    </div>
  );
}
