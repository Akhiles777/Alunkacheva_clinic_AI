"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CHANNEL_LABEL,
  DIALOG_FILTERS,
  DIALOG_STATUS_LABEL,
  dialogMatchesFilter,
} from "@/app/_data/inbox";
import {
  activeNotes,
  findPatient,
  markDialogRead,
  returnToBot,
  sendMessage,
  useDb,
  type Dialog,
} from "@/app/_data/store";
import { getApprovedTemplates, type ApprovedTemplate } from "./actions";
import { ComposeOverlay } from "../_components/compose-overlay";
import { PatientCardBody } from "../_components/patient-card";

const NOTE_SHORT: Record<string, string> = {
  NO_CONSENT: "нет согласия",
  INCOMPLETE_PASSPORT: "нет паспорта",
  ATTENTION: "внимание",
  CUSTOM: "заметка",
};

const QUICK_REPLIES = [
  "Здравствуйте! Чем можем помочь?",
  "Подскажите ваш телефон для записи.",
  "Спасибо за обращение, хорошего дня!",
];

function DialogRow({
  dialog,
  active,
  onClick,
}: {
  dialog: Dialog;
  active: boolean;
  onClick: () => void;
}) {
  const patient = dialog.patientId ? findPatient(dialog.patientId) : undefined;
  const notes = patient ? activeNotes(patient) : [];

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
      {/* Служебные отметки пациента видны сразу у имени (§5.3). */}
      {notes.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {notes.slice(0, 2).map((n) => (
            <span key={n.id} className="text-accent-text bg-accent-tint rounded-sm px-1.5 py-px text-2xs font-medium">
              {NOTE_SHORT[n.kind]}
            </span>
          ))}
        </div>
      ) : null}
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

function WindowBadge({ dialog }: { dialog: Dialog }) {
  if (!dialog.windowOpen) {
    return (
      <span className="border-accent-border bg-accent-tint text-accent-text flex-none rounded-sm border px-2 py-1 text-2xs font-medium">
        окно закрыто · только шаблон
      </span>
    );
  }
  if (dialog.windowMinutesLeft !== null) {
    const h = Math.floor(dialog.windowMinutesLeft / 60);
    const m = dialog.windowMinutesLeft % 60;
    const label = h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
    return (
      <span className="text-text-muted flex-none text-2xs">
        окно ответа: <span className="num">{label}</span>
      </span>
    );
  }
  return null;
}

function Thread({ dialog, onBack }: { dialog: Dialog; onBack: () => void }) {
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [approvedTemplates, setApprovedTemplates] = useState<ApprovedTemplate[]>([]);

  useEffect(() => {
    let alive = true;
    getApprovedTemplates().then((t) => {
      if (alive) setApprovedTemplates(t);
    });
    return () => {
      alive = false;
    };
  }, []);

  function submit() {
    if (dialog.windowOpen && text.trim()) {
      // Показываем результат доставки: молчаливый «успех» при неотправленном
      // сообщении — худший исход, администратор будет ждать ответа зря.
      void sendMessage(dialog.id, text).then((res) => {
        setSendError(res.ok ? null : (res.error ?? "Сообщение не отправлено"));
      });
      setText("");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex flex-none items-center gap-3 border-b px-5 py-3.5 max-md:flex-wrap max-md:gap-y-1.5">
        <button type="button" onClick={onBack} className="text-text-muted hover:text-text text-sm md:hidden">
          ← Диалоги
        </button>
        <div className="min-w-0 max-md:order-3 max-md:w-full">
          <div className="truncate text-sm font-medium">
            {dialog.patientId ? (
              <Link href={`/patients/${dialog.patientId}`} className="hover:underline">
                {dialog.name}
              </Link>
            ) : (
              dialog.name
            )}
          </div>
          <div className="text-text-subtle text-2xs">
            {CHANNEL_LABEL[dialog.channel]} · {DIALOG_STATUS_LABEL[dialog.status]}
          </div>
        </div>
        <div className="ml-auto flex flex-none items-center gap-2.5">
          {dialog.status !== "bot" ? (
            <button
              type="button"
              onClick={() => returnToBot(dialog.id)}
              title="Снять паузу агента: после ручного ответа он молчит 12 часов"
              className="border-border text-text-muted hover:bg-hover flex-none rounded-md border px-2.5 py-1 text-2xs"
            >
              Вернуть агенту
            </button>
          ) : null}
          {dialog.status === "escalated" ? (
            <span className="text-accent-text flex-none text-2xs font-medium max-md:hidden">
              эскалация: {dialog.escalationReason}
            </span>
          ) : null}
          <WindowBadge dialog={dialog} />
        </div>
      </div>

      <div className="flex-1 overflow-auto px-5 py-4">
        <div className="flex flex-col gap-3">
          {dialog.messages.map((m) => {
            const mine = m.from !== "patient";
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[78%]">
                  <div
                    className={`rounded-xl px-3.5 py-2 text-sm leading-snug ${
                      m.from === "patient" ? "bg-surface border-border border" : "bg-raise text-text"
                    }`}
                  >
                    {m.text}
                  </div>
                  <div className={`num text-text-subtle mt-1 text-2xs ${mine ? "text-right" : ""}`}>
                    {m.from === "bot" ? "агент · " : m.from === "staff" ? "вы · " : ""}
                    {m.at}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {dialog.agentDraft ? (
        <div className="border-border bg-accent-tint flex-none border-t px-5 py-3">
          <div className="text-accent-text mb-1.5 text-2xs font-medium">
            Черновик агента — проверьте перед отправкой
          </div>
          <p className="text-text mb-2.5 text-sm leading-snug">{dialog.agentDraft}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => sendMessage(dialog.id, dialog.agentDraft!)}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3 py-1.5 text-sm font-medium"
            >
              Отправить
            </button>
            <button
              type="button"
              onClick={() => setText(dialog.agentDraft!)}
              className="border-border text-text-muted hover:bg-hover rounded-md border px-3 py-1.5 text-sm"
            >
              Изменить
            </button>
          </div>
        </div>
      ) : null}

      {/* Результат доставки. Молчаливый «успех» при неотправленном сообщении —
          худший исход: администратор будет напрасно ждать ответа пациента. */}
      {sendError ? (
        <div className="border-border-soft bg-hover text-accent-text flex-none border-t px-5 py-2 text-xs">
          {sendError}
        </div>
      ) : null}

      {/* Композер: окно открыто — свободный текст; закрыто — только шаблоны. */}
      {dialog.windowOpen ? (
        <div className="border-border flex-none border-t px-5 py-3">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {QUICK_REPLIES.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setText(q)}
                className="border-border text-text-muted hover:bg-hover truncate rounded-md border px-2 py-1 text-2xs"
              >
                {q.length > 34 ? q.slice(0, 32) + "…" : q}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="Ответить вручную…"
              className="border-border-input bg-surface placeholder:text-text-subtle flex-1 rounded-md border px-3 py-2 text-sm outline-none"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim()}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
            >
              Отправить
            </button>
          </div>
        </div>
      ) : (
        <div className="border-border flex-none border-t px-5 py-3">
          <p className="text-text-muted mb-2 text-xs">
            24-часовое окно закрыто. Написать первым можно только утверждённым
            шаблоном.
          </p>
          {approvedTemplates.length === 0 ? (
            <p className="text-text-subtle text-sm">
              Нет утверждённых шаблонов.{" "}
              <Link href="/settings/templates" className="text-accent-text hover:underline">
                Добавить
              </Link>
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {approvedTemplates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => sendMessage(dialog.id, t.body)}
                  className="border-accent-border bg-accent-tint text-accent-text hover:bg-accent hover:text-accent-contrast rounded-md border px-3 py-1.5 text-sm font-medium"
                >
                  {t.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


export default function InboxPage() {
  const db = useDb();
  const [filter, setFilter] = useState("need");
  const [selectedId, setSelectedId] = useState<string | null>("d-grinberg");
  const [composing, setComposing] = useState(false);

  const list = useMemo(
    () => db.dialogs.filter((d) => dialogMatchesFilter(d, filter)),
    [db.dialogs, filter],
  );
  const selected = db.dialogs.find((d) => d.id === selectedId) ?? null;
  const patient = selected?.patientId ? findPatient(selected.patientId) : undefined;

  function open(id: string) {
    setSelectedId(id);
    markDialogRead(id);
  }

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div
        className={`border-border flex w-[300px] flex-none flex-col border-r max-md:w-full ${selected ? "max-md:hidden" : ""}`}
      >
        <div className="border-border flex-none border-b px-4 py-3.5">
          <div className="flex items-center justify-between">
            <h1 className="text-md font-medium">Диалоги</h1>
            <button
              type="button"
              onClick={() => setComposing(true)}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-2.5 py-1 text-xs font-medium"
            >
              + Написать
            </button>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1">
            {DIALOG_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`rounded-md px-2 py-1 text-2xs ${
                  filter === f.id ? "bg-nav-active text-accent-text font-medium" : "text-text-muted hover:bg-hover"
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
              <DialogRow key={d.id} dialog={d} active={d.id === selectedId} onClick={() => open(d.id)} />
            ))
          )}
        </div>
      </div>

      <div className={`min-w-0 flex-1 ${selected ? "" : "max-md:hidden"}`}>
        {selected ? (
          <Thread dialog={selected} onBack={() => setSelectedId(null)} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-text-subtle text-sm">Выберите диалог слева.</p>
          </div>
        )}
      </div>

      <div className="border-border w-[320px] flex-none overflow-auto border-l px-5 py-5 max-xl:hidden">
        {patient ? (
          <PatientCardBody patientId={patient.id} />
        ) : selected ? (
          <div>
            <div className="text-md font-medium">Пациент не опознан</div>
            <p className="text-text-muted mt-2 text-sm leading-snug">
              Номер не найден в базе. Один номер бывает у семьи — свяжите диалог
              с карточкой вручную, чтобы не приклеить чужую историю.
            </p>
            <Link href="/patients" className="text-accent-text mt-3 inline-block text-sm hover:underline">
              Найти пациента
            </Link>
          </div>
        ) : null}
      </div>

      {composing ? <ComposeOverlay onClose={() => setComposing(false)} /> : null}
    </div>
  );
}
