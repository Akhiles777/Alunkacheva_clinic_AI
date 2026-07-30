"use client";

import { useState } from "react";
import Link from "next/link";
import { Modal } from "../_components/modal";
import { PatientCardBody } from "../_components/patient-card";
import { findPatient, removePatient } from "@/app/_data/store";

/**
 * Карточка пациента в нормальном центрированном модальном окне (вместо прежней
 * узкой правой панели). Тот же PatientCardBody с редактированием.
 */
export function PatientModal({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const patient = findPatient(patientId);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={patient?.name ?? "Пациент"}
      description="Карточка пациента"
      footer={
        confirmDelete ? (
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
          <>
            <Link
              href={`/patients/${patientId}`}
              className="text-accent-text mr-auto text-sm hover:underline"
            >
              Открыть страницу
            </Link>
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="text-text-subtle hover:text-text text-sm"
            >
              Удалить пациента
            </button>
          </>
        )
      }
    >
      <PatientCardBody patientId={patientId} editable />
    </Modal>
  );
}
