"use client";

import { useParams } from "next/navigation";
import { PatientDetail } from "../patient-detail";

export default function PatientPage() {
  const params = useParams<{ id: string }>();
  return <PatientDetail id={params.id} />;
}
