"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { PatientCardBody } from "../../_components/patient-card";
import { findPatient, useDb } from "@/app/_data/store";

export default function PatientPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  useDb(); // подписка на стор — карточка обновляется при правках
  const patient = findPatient(id);

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
          <div className="border-border bg-surface max-w-[560px] rounded-xl border p-6">
            <PatientCardBody patientId={id} editable />
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
