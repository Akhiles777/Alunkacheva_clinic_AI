import Link from "next/link";
import { notFound } from "next/navigation";
import { PatientCardBody } from "../../_components/patient-card";
import { findPatient } from "@/app/_data/patients";

export default async function PatientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const patient = findPatient(id);
  if (!patient) notFound();

  return (
    <>
      <header className="border-border flex flex-none items-center gap-2 border-b px-7 py-[18px] text-xs max-md:px-5">
        <Link href="/patients" className="text-text-muted hover:text-text">
          Пациенты
        </Link>
        <span aria-hidden className="sep-dot" />
        <span className="text-text truncate">{patient.name}</span>
      </header>

      <div className="flex-1 overflow-auto px-7 py-7 max-md:px-5">
        <div className="border-border bg-surface max-w-[560px] rounded-xl border p-6">
          <PatientCardBody patient={patient} />
        </div>
      </div>
    </>
  );
}
