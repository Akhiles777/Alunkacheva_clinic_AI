"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PatientCardBody } from "../../_components/patient-card";
import { PatientAnalyticsPanel } from "../patient-analytics-panel";
import { findPatient, useDb } from "@/app/_data/store";
import { logPatientView } from "../actions";

export default function PatientPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  useDb(); // подписка на стор — карточка обновляется при правках
  const patient = findPatient(id);

  // Просмотр медицинской карточки фиксируется в журнале (§7).
  useEffect(() => {
    if (id) void logPatientView(id).catch(() => {});
  }, [id]);

  return (
    <>
      <header className="border-border flex flex-none items-center gap-2 border-b px-7 py-[18px] text-xs max-md:px-5">
        <Link href="/patients" className="text-text-muted hover:text-text">
          Пациенты
        </Link>
        <span aria-hidden className="sep-dot" />
        <span className="text-text truncate">{patient?.name ?? "Пациент не найден"}</span>
      </header>

      <div className="flex-1 overflow-auto px-7 py-7 max-md:px-5">
        {patient ? (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="border-border bg-surface rounded-xl border p-6">
              <PatientCardBody patientId={id} editable />
            </div>
            <PatientAnalyticsPanel patientId={id} />
          </div>
        ) : (
          <p className="text-text-muted text-sm">
            Такого пациента нет. Возможно, он был удалён.{" "}
            <Link href="/patients" className="text-accent-text hover:underline">
              К списку
            </Link>
          </p>
        )}
      </div>
    </>
  );
}
