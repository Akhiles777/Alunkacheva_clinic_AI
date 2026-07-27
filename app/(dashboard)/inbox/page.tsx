"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  CHANNEL_LABEL,
  DIALOG_FILTERS,
  DIALOG_STATUS_LABEL,
  DIALOGS,
  dialogMatchesFilter,
  type Dialog,
} from "@/app/_data/inbox";
import { findPatient } from "@/app/_data/patients";
import { PatientCardBody } from "../_components/patient-card";

function DialogRow({
  dialog,
  active,
  onClick,
}: {
  dialog: Dialog;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full border-b border-border-soft px-4 py-3 text-left last:border-b-0 ${
        active ? "bg-nav-active" : "hover:bg-hover"
      }`}
    >
      <div className="flex items-baseline gap-2">
        {dialog.unread ? (
          <span aria-hidden className="bg-accent h-1.5 w-1.5 flex-none rounded-full" />
        ) : null}
        <span className="truncate text-sm font-medium">{dialog.name}</span>
        <span className="num text-text-subtle ml-auto flex-none text-2xs">{dialog.at}</span>
      </div>
      <p className="text-text-muted mt-1 truncate text-xs">{dialog.preview}</p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="text-text-subtle text-2xs">{CHANNEL_LABEL[dialog.channel]}</span>
        {dialog.status === "escalated" ? (
          <span className="text-accent-text text-2xs font-medium">· нужен человек</span>
        ) : dialog.agentDraft ? (
          <span className="text-accent-text text-2xs font-medium">· черновик готов</span>
        ) : (
          <span className="text-text-subtle text-2xs">· {DIALOG_STATUS_LABEL[dialog.status]}</span>
        )}
      </div>
    </button>
  );
}

function Thread({ dialog, onBack }: { dialog: Dialog; onBack: () => void }) {
  const [draftSent, setDraftSent] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex flex-none items-center gap-3 border-b px-5 py-3.5">
        <button
          type="button"
          onClick={onBack}
          className="text-text-muted hover:text-text text-sm md:hidden"
        >
          ← Диалоги
        </button>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{dialog.name}</div>
          <div className="text-text-subtle text-2xs">
            {CHANNEL_LABEL[dialog.channel]} · {DIALOG_STATUS_LABEL[dialog.status]}
          </div>
        </div>
        {dialog.status === "escalated" ? (
          <span className="border-accent-border bg-accent-tint text-accent-text ml-auto flex-none rounded-sm border px-2 py-1 text-2xs font-medium max-md:hidden">
            эскалация: {dialog.escalationReason}
          </span>
        ) : null}
      </div>

      <div className="flex-1 overflow-auto px-5 py-4">
        <div className="flex flex-col gap-3">
          {dialog.messages.map((m) => {
            const mine = m.from !== "patient";
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[78%]">
                  {/* Акцент зарезервирован под действия и окна — исходящие
                      сообщения нейтральные, роль подписана снизу. */}
                  <div
                    className={`rounded-xl px-3.5 py-2 text-sm leading-snug ${
                      m.from === "patient"
                        ? "bg-surface border-border border"
                        : "bg-raise text-text"
                    }`}
                  >
                    {m.text}
                  </div>
                  <div
                    className={`num text-text-subtle mt-1 text-2xs ${mine ? "text-right" : ""}`}
                  >
                    {m.from === "bot" ? "агент · " : m.from === "staff" ? "вы · " : ""}
                    {m.at}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Черновик агента — suggest-режим: администратор отправляет или правит. */}
      {dialog.agentDraft && !draftSent ? (
        <div className="border-border bg-accent-tint flex-none border-t px-5 py-3">
          <div className="text-accent-text mb-1.5 text-2xs font-medium">
            Черновик агента — проверьте перед отправкой
          </div>
          <p className="text-text mb-2.5 text-sm leading-snug">{dialog.agentDraft}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setDraftSent(true)}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3 py-1.5 text-sm font-medium"
            >
              Отправить
            </button>
            <button
              type="button"
              className="border-border text-text-muted hover:bg-hover rounded-md border px-3 py-1.5 text-sm"
            >
              Изменить
            </button>
          </div>
        </div>
      ) : null}

      <div className="border-border flex flex-none items-center gap-2 border-t px-5 py-3">
        <input
          placeholder="Ответить вручную…"
          className="border-border-input bg-surface placeholder:text-text-subtle flex-1 rounded-md border px-3 py-2 text-sm outline-none"
        />
        <button
          type="button"
          className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium"
        >
          Отправить
        </button>
      </div>
    </div>
  );
}

export default function InboxPage() {
  const [filter, setFilter] = useState("need");
  const [selectedId, setSelectedId] = useState<string | null>("d-grinberg");

  const list = useMemo(() => DIALOGS.filter((d) => dialogMatchesFilter(d, filter)), [filter]);
  const selected = DIALOGS.find((d) => d.id === selectedId) ?? null;
  const patient = selected?.patientId ? findPatient(selected.patientId) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* Левая колонка — список */}
      <div
        className={`border-border flex w-[300px] flex-none flex-col border-r max-md:w-full ${
          selected ? "max-md:hidden" : ""
        }`}
      >
        <div className="border-border flex-none border-b px-4 py-3.5">
          <h1 className="text-md font-medium">Диалоги</h1>
          <div className="mt-2.5 flex flex-wrap gap-1">
            {DIALOG_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`rounded-md px-2 py-1 text-2xs ${
                  filter === f.id
                    ? "bg-nav-active text-accent-text font-medium"
                    : "text-text-muted hover:bg-hover"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {list.length === 0 ? (
            <p className="text-text-muted px-4 py-6 text-sm">В этом фильтре пусто.</p>
          ) : (
            list.map((d) => (
              <DialogRow
                key={d.id}
                dialog={d}
                active={d.id === selectedId}
                onClick={() => setSelectedId(d.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Центр — переписка */}
      <div className={`min-w-0 flex-1 ${selected ? "" : "max-md:hidden"}`}>
        {selected ? (
          <Thread dialog={selected} onBack={() => setSelectedId(null)} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-text-subtle text-sm">Выберите диалог слева.</p>
          </div>
        )}
      </div>

      {/* Правая колонка — карточка пациента, 320px */}
      <div className="border-border w-[320px] flex-none overflow-auto border-l px-5 py-5 max-xl:hidden">
        {patient ? (
          <PatientCardBody patient={patient} />
        ) : selected ? (
          <div>
            <div className="text-md font-medium">Пациент не опознан</div>
            <p className="text-text-muted mt-2 text-sm leading-snug">
              Номер не найден в базе. Один номер бывает у семьи — свяжите диалог
              с карточкой вручную, чтобы не приклеить чужую историю.
            </p>
            <Link
              href="/patients"
              className="text-accent-text mt-3 inline-block text-sm hover:underline"
            >
              Найти пациента
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}
