"use client";

import { useEffect, useState } from "react";
import { PatientDetail } from "../patients/patient-detail";

/**
 * Карточка пациента поверх «Диалогов».
 *
 * Открывается событием `open-patient` (как запись и звонок — `open-booking`,
 * `open-call`): администратор смотрит историю, курсы и отметки, не теряя
 * переписку, и закрывает панель Esc или щелчком мимо. Ссылка с ⌘/Ctrl по-прежнему
 * открывает карточку отдельной вкладкой.
 */
export function openPatient(id: string): void {
  window.dispatchEvent(new CustomEvent("open-patient", { detail: { id } }));
}

/** Клик по ссылке на карточку: обычный — панель, с модификатором — как ссылка. */
export function patientLinkClick(e: React.MouseEvent, id: string): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  openPatient(id);
}

export function PatientOverlay() {
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    const open = (e: Event) => setId((e as CustomEvent<{ id: string }>).detail?.id ?? null);
    window.addEventListener("open-patient", open);
    return () => window.removeEventListener("open-patient", open);
  }, []);

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Esc закрывает панель, а не уходит дальше в обработчики инбокса.
        e.stopImmediatePropagation();
        setId(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [id]);

  if (!id) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Карточка пациента">
      <button type="button" aria-label="Закрыть карточку" onClick={() => setId(null)} className="flex-1 cursor-default bg-black/40" />
      <div className="bg-bg border-border flex h-full w-full max-w-[720px] flex-col overflow-hidden border-l shadow-xl">
        <PatientDetail id={id} overlay onClose={() => setId(null)} />
      </div>
    </div>
  );
}
