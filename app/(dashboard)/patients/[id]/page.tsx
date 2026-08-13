"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PatientCardBody } from "../../_components/patient-card";
import { PatientAnalyticsPanel } from "../patient-analytics-panel";
import { findPatient, hydratePatients, useDb } from "@/app/_data/store";
import { getPatientRecord, logPatientView } from "../actions";

export default function PatientPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  useDb(); // подписка на стор — карточка обновляется при правках
  const patient = findPatient(id);

  /**
   * Пока карточку не нашли в сторе, не утверждаем, что её нет.
   *
   * Стор наполняется один раз при загрузке дашборда: пациент, заведённый
   * позже — из диалога, ботом или выгрузкой YCLIENTS, — в нём отсутствует, и
   * экран показывал «такого пациента нет» для только что созданной карточки.
   * Догружаем её с сервера и лишь потом судим.
   */
  const [lookup, setLookup] = useState<"idle" | "loading" | "missing">("idle");

  useEffect(() => {
    if (!id || patient) return;
    let alive = true;
    setLookup("loading");
    getPatientRecord(id)
      .then((record) => {
        if (!alive) return;
        if (record) hydratePatients([record]);
        else setLookup("missing");
      })
      .catch(() => alive && setLookup("missing"));
    return () => {
      alive = false;
    };
    // Ищем один раз на карточку: появится в сторе — эффект больше не нужен.
  }, [id, patient]);

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
        <span className="text-text truncate">
          {patient?.name ?? (lookup === "missing" ? "Пациент не найден" : "Загружаем…")}
        </span>
      </header>

      <div className="flex-1 overflow-auto px-7 py-7 max-md:px-5">
        {patient ? (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="border-border bg-surface rounded-xl border p-6">
              <PatientCardBody patientId={id} editable />
            </div>
            <PatientAnalyticsPanel patientId={id} />
          </div>
        ) : lookup === "missing" ? (
          <p className="text-text-muted text-sm">
            Такого пациента нет. Возможно, он был удалён.{" "}
            <Link href="/patients" className="text-accent-text hover:underline">
              К списку
            </Link>
          </p>
        ) : (
          <p className="text-text-subtle text-sm">Загружаем карточку…</p>
        )}
      </div>
    </>
  );
}
