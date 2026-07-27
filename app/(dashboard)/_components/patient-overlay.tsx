"use client";

import { useEffect } from "react";
import Link from "next/link";
import { PatientCardBody } from "./patient-card";
import type { Patient } from "@/app/_data/patients";

/**
 * Карточка пациента как узкая панель-оверлей справа. Тот же PatientCardBody,
 * что и в колонке «Диалогов» и на странице /patients/[id] — меняется только
 * обёртка.
 */
export function PatientOverlay({
  patient,
  onClose,
}: {
  patient: Patient;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="overlay-scrim fixed inset-0 z-40 flex justify-end"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="bg-surface flex h-full w-full max-w-[380px] flex-col"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Карточка: ${patient.name}`}
      >
        <div className="border-border flex flex-none items-center justify-between border-b px-5 py-3.5">
          <Link
            href={`/patients/${patient.id}`}
            className="text-accent-text text-xs hover:underline"
          >
            Открыть страницу
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="text-text-subtle hover:text-text rounded-sm px-1 text-lg leading-none"
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-5">
          <PatientCardBody patient={patient} />
        </div>
      </div>
    </div>
  );
}
