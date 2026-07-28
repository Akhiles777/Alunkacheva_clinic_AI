"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PatientCardBody } from "./patient-card";
import { findPatient, removePatient } from "@/app/_data/store";

/**
 * Карточка пациента как узкая панель-оверлей справа. Тот же PatientCardBody,
 * что в колонке «Диалогов» и на странице /patients/[id]; в оверлее — с
 * редактированием.
 */
export function PatientOverlay({
  patientId,
  onClose,
}: {
  patientId: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const patient = findPatient(patientId);

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
        aria-label={`Карточка: ${patient?.name ?? ""}`}
      >
        <div className="border-border flex flex-none items-center justify-between border-b px-5 py-3.5">
          <Link href={`/patients/${patientId}`} className="text-accent-text text-xs hover:underline">
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
          <PatientCardBody patientId={patientId} editable />
        </div>
        <div className="border-border flex flex-none items-center justify-end gap-3 border-t px-5 py-3">
          {confirmDelete ? (
            <>
              <span className="text-text-muted mr-auto text-xs">Удалить пациента без возможности вернуть?</span>
              <button
                type="button"
                onClick={() => {
                  removePatient(patientId);
                  onClose();
                }}
                className="text-accent-text text-sm font-medium hover:underline"
              >
                Да, удалить
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="text-text-muted hover:text-text text-sm"
              >
                Отмена
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="text-text-subtle hover:text-text text-sm"
            >
              Удалить пациента
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
