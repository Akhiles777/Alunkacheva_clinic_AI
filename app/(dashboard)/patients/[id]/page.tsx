"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PatientCardBody } from "../../_components/patient-card";
import { PatientAnalyticsPanel } from "../patient-analytics-panel";
import { hydratePatients, useDb } from "@/app/_data/store";
import { getPatientRecord, logPatientView } from "../actions";

export default function PatientPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  /**
   * Пациента читаем ЧЕРЕЗ снимок стора, а не прямым обращением к модулю.
   *
   * `findPatient` читает живое состояние; на сервере оно пустое, а к моменту
   * гидрации на клиенте уже заполнено — и React ловил расхождение: «сервер
   * отрисовал „Загружаем…“, клиент — имя». Из-за такого расхождения React
   * выбрасывает серверную разметку и рисует поддерево заново, а на экране это
   * и выглядит как «страница дёргается и долго грузит».
   */
  const db = useDb();
  const patient = db.patients.find((p) => p.id === id);

  /**
   * Карточку всегда догружаем с сервера, даже если пациент уже в сторе.
   *
   * В сторе он оказывается из списка, а список не запрашивает историю визитов
   * — тянуть её на всю базу незачем. Прежде эффект выходил на первой же
   * проверке «пациент уже есть», и карточка показывала пустую историю всегда,
   * сколько бы визитов ни было в базе.
   *
   * Заодно это закрывает второй случай: пациента, заведённого позже загрузки
   * дашборда — из диалога, ботом или выгрузкой YCLIENTS, — в сторе нет вовсе,
   * и экран сообщал «такого пациента нет» для только что созданной карточки.
   */
  const [lookup, setLookup] = useState<"searching" | "missing">("searching");
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!id || loadedFor.current === id) return;
    loadedFor.current = id;
    let alive = true;
    // Время запроса: ответ, ушедший раньше правки карточки, не должен затирать
    // только что добавленную пометку или номер (см. hydratePatients).
    const at = Date.now();
    getPatientRecord(id)
      .then((record) => {
        if (!alive) return;
        if (record) hydratePatients([record], at);
        else setLookup("missing");
      })
      .catch(() => alive && setLookup("missing"));
    return () => {
      alive = false;
    };
  }, [id]);

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
