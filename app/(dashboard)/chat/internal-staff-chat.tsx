"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  deleteInternalMessage,
  getInternalChatState,
  openDirectChat,
  sendInternalMessage,
  type InternalChatAttachment,
  type InternalChatState,
} from "./actions";
import { patientTags, primaryPhone, useDb } from "@/app/_data/store";

function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(iso));
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    OWNER: "владелец",
    ADMIN: "администратор",
    MANAGER: "менеджер",
    DOCTOR: "врач",
  };
  return labels[role] ?? role.toLowerCase();
}

function firstVoice(attachments: InternalChatAttachment[]): InternalChatAttachment | null {
  return attachments.find((a) => a.kind === "voice" && a.dataUrl) ?? null;
}

function dataUrlFromBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function InternalStaffChat({ compact = false }: { compact?: boolean }) {
  const db = useDb();
  const [state, setState] = useState<InternalChatState | null>(null);
  const [text, setText] = useState("");
  const [shareId, setShareId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordStartedAtRef = useRef<number>(0);
  const endRef = useRef<HTMLDivElement | null>(null);

  const activeRoom = state?.rooms.find((r) => r.id === state.activeRoomId) ?? null;
  const sharePatient = db.patients.find((p) => p.id === shareId) ?? null;
  const activeCourse = sharePatient?.courses.find((c) => c.status !== "done");

  const peers = useMemo(() => state?.staff.filter((s) => !s.isSelf) ?? [], [state]);
  const doctors = useMemo(
    () => peers.filter((s) => s.role === "DOCTOR" || s.staffId !== null),
    [peers],
  );
  const team = useMemo(
    () => peers.filter((s) => s.role !== "DOCTOR" && s.staffId === null),
    [peers],
  );

  useEffect(() => {
    let alive = true;
    getInternalChatState()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : "Не удалось открыть чат.");
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [state?.messages.length, state?.activeRoomId]);

  function run(action: () => Promise<InternalChatState>) {
    setError(null);
    startTransition(async () => {
      try {
        setState(await action());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Действие не выполнено.");
      }
    });
  }

  function send(body: string, attachments?: InternalChatAttachment[]) {
    if (!state) return;
    run(() => sendInternalMessage({ roomId: state.activeRoomId, body, attachments }));
  }

  async function startVoice() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Браузер не поддерживает запись голоса.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recordStartedAtRef.current = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size === 0) return;
        try {
          const dataUrl = await dataUrlFromBlob(blob);
          const durationSec = Math.max(1, Math.round((Date.now() - recordStartedAtRef.current) / 1000));
          send("", [{ kind: "voice", dataUrl, mimeType: blob.type, durationSec }]);
        } catch {
          setError("Не удалось подготовить голосовое сообщение.");
        }
      };
      recorder.start();
      setRecording(true);
    } catch {
      setError("Нет доступа к микрофону.");
    }
  }

  function stopVoice() {
    mediaRecorderRef.current?.stop();
  }

  return (
    <section className={`border-border bg-surface flex min-h-0 rounded-xl border ${compact ? "h-[460px]" : "h-[calc(100vh-136px)]"}`}>
      <aside className="border-border-soft flex w-[260px] flex-none flex-col border-r max-md:hidden">
        <div className="border-border-soft border-b px-4 py-3">
          <h2 className="text-sm font-medium">Чаты</h2>
          <p className="text-text-subtle text-2xs">общий канал и личные диалоги</p>
        </div>

        <div className="flex-1 overflow-auto p-2">
          {state?.rooms.map((room) => (
            <button
              key={room.id}
              type="button"
              onClick={() => run(() => getInternalChatState(room.id))}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${
                room.id === state.activeRoomId ? "bg-nav-active text-accent-text font-medium" : "text-text-muted hover:bg-hover"
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{room.title}</span>
              {room.unread > 0 ? (
                <span className="num bg-chip-strong text-text-muted rounded-pill px-[7px] py-px text-2xs">{room.unread}</span>
              ) : null}
            </button>
          ))}

          <StaffDirectorySection title="Врачи" empty="Нет врачей с учётной записью" people={doctors} onOpen={(id) => run(() => openDirectChat(id))} />
          <StaffDirectorySection title="Команда" empty="Нет других сотрудников" people={team} onOpen={(id) => run(() => openDirectChat(id))} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-border-soft flex flex-none items-center justify-between gap-3 border-b px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium">{activeRoom?.title ?? "Чат сотрудников"}</h2>
            <p className="text-text-subtle text-2xs">
              {state?.me ? `${state.me.name} · ${roleLabel(state.me.role)}` : "загрузка…"}
            </p>
          </div>
          <div className="flex flex-none items-center gap-2">
            {state ? (
              <>
                <select
                  value={state.activeRoomId}
                  onChange={(e) => run(() => getInternalChatState(e.target.value))}
                  aria-label="Чат"
                  className="border-border-input bg-surface hidden max-w-[150px] rounded-md border px-2 py-1.5 text-xs outline-none max-md:block"
                >
                  {state.rooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.title}
                    </option>
                  ))}
                </select>
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) run(() => openDirectChat(e.target.value));
                  }}
                  aria-label="Открыть личный чат"
                  className="border-border-input bg-surface hidden max-w-[150px] rounded-md border px-2 py-1.5 text-xs outline-none max-md:block"
                >
                  <option value="">сотрудник…</option>
                  {peers.map((staff) => (
                    <option key={staff.id} value={staff.id}>
                      {staff.role === "DOCTOR" || staff.staffId ? `Врач: ${staff.name}` : staff.name}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            {isPending ? <span className="text-text-subtle text-2xs">синхронизация…</span> : null}
          </div>
        </div>

        {error ? <div className="border-border-soft bg-hover text-text-muted border-b px-5 py-2 text-xs">{error}</div> : null}

        <div className="flex-1 overflow-auto px-5 py-4">
          {!state ? (
            <div className="skeleton h-full rounded-lg" />
          ) : state.messages.length === 0 ? (
            <div className="text-text-subtle flex h-full items-center justify-center text-sm">Пока нет сообщений.</div>
          ) : (
            <div className="space-y-3">
              {state.messages.map((message) => {
                const voice = firstVoice(message.attachments);
                return (
                  <div key={message.id} className={`flex flex-col ${message.mine ? "items-end" : "items-start"}`}>
                    <div className="text-text-subtle mb-0.5 flex max-w-[82%] items-center gap-1.5 text-2xs">
                      <span className="truncate">{message.mine ? "вы" : message.authorName}</span>
                      <span aria-hidden className="sep-dot" />
                      <span className="num">{timeLabel(message.createdAt)}</span>
                      {message.canDelete ? (
                        <button
                          type="button"
                          onClick={() => run(() => deleteInternalMessage(message.id))}
                          className="hover:text-text ml-1"
                        >
                          удалить
                        </button>
                      ) : null}
                    </div>
                    <div
                      className={`max-w-[82%] rounded-2xl px-3.5 py-2 text-sm ${
                        message.mine ? "bg-accent text-accent-contrast" : "bg-hover text-text"
                      } ${message.deleted ? "text-text-subtle bg-hover italic" : ""}`}
                    >
                      {message.deleted ? (
                        "Сообщение удалено"
                      ) : (
                        <>
                          {message.body ? <div className="whitespace-pre-line">{message.body}</div> : null}
                          {voice?.dataUrl ? (
                            <div className="min-w-[220px]">
                              <audio controls src={voice.dataUrl} className="h-9 w-full" />
                              {voice.durationSec ? <div className="mt-1 text-2xs opacity-75">{voice.durationSec} сек.</div> : null}
                            </div>
                          ) : null}
                          {message.attachments.filter((a) => a.kind !== "voice").map((attachment, index) => (
                            <div
                              key={`${message.id}-${index}`}
                              className={`mt-1.5 rounded-lg border px-2.5 py-1.5 ${
                                message.mine ? "border-accent-border" : "border-border"
                              }`}
                            >
                              <div className="text-2xs opacity-80">
                                {attachment.kind === "patient" ? "карточка пациента" : "курс"}
                              </div>
                              {attachment.label ? <div className="text-sm font-medium">{attachment.label}</div> : null}
                              {attachment.detail ? <div className="text-2xs opacity-80">{attachment.detail}</div> : null}
                              {attachment.patientId ? (
                                <Link
                                  href={`/patients/${attachment.patientId}`}
                                  className={`text-2xs underline ${message.mine ? "" : "text-accent-text"}`}
                                >
                                  открыть
                                </Link>
                              ) : null}
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <div className="border-border-soft flex-none border-t px-5 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <select
              value={shareId}
              onChange={(e) => setShareId(e.target.value)}
              aria-label="Пациент для отправки"
              className="border-border-input bg-surface rounded-md border px-2.5 py-1.5 text-sm outline-none"
            >
              <option value="">прикрепить пациента…</option>
              {db.patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!sharePatient || !state}
              onClick={() => {
                if (!sharePatient) return;
                send("", [{
                  kind: "patient",
                  label: sharePatient.name,
                  detail: `${primaryPhone(sharePatient)?.pretty ?? "нет номера"} · ${patientTags(sharePatient).join(", ") || "без меток"}`,
                  patientId: sharePatient.id,
                }]);
                setShareId("");
              }}
              className="border-border text-text-muted hover:bg-hover rounded-md border px-2.5 py-1.5 text-xs disabled:opacity-45"
            >
              Карточка
            </button>
            <button
              type="button"
              disabled={!activeCourse || !state}
              onClick={() => {
                if (!sharePatient || !activeCourse) return;
                send("", [{
                  kind: "course",
                  label: `${activeCourse.title} — ${sharePatient.name}`,
                  detail: `${activeCourse.used}/${activeCourse.total}, ${activeCourse.status === "stalled" ? "выпал из графика" : "идёт по курсу"}`,
                  patientId: sharePatient.id,
                }]);
                setShareId("");
              }}
              className="border-border text-text-muted hover:bg-hover rounded-md border px-2.5 py-1.5 text-xs disabled:opacity-45"
            >
              Курс
            </button>
          </div>

          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const next = text;
              setText("");
              send(next);
            }}
          >
            <button
              type="button"
              onClick={recording ? stopVoice : startVoice}
              disabled={!state}
              className={`border-border rounded-md border px-3 py-2 text-sm ${
                recording ? "bg-accent text-accent-contrast" : "text-text-muted hover:bg-hover"
              } disabled:opacity-45`}
            >
              {recording ? "Стоп" : "Голос"}
            </button>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Сообщение коллегам…"
              className="border-border-input bg-surface placeholder:text-text-subtle min-w-0 flex-1 rounded-md border px-3 py-2 text-sm outline-none"
            />
            <button
              type="submit"
              disabled={!text.trim() || !state}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
            >
              Отправить
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}

function StaffDirectorySection({
  title,
  empty,
  people,
  onOpen,
}: {
  title: string;
  empty: string;
  people: NonNullable<InternalChatState["staff"]>;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="mt-4">
      <div className="text-text-subtle px-3 text-2xs">{title}</div>
      <div className="mt-1 flex flex-col gap-0.5">
        {people.length === 0 ? (
          <div className="text-text-subtle px-3 py-2 text-2xs">{empty}</div>
        ) : (
          people.map((staff) => {
            const detail = staff.specialty || roleLabel(staff.role);
            return (
              <button
                key={staff.id}
                type="button"
                onClick={() => onOpen(staff.id)}
                className="hover:bg-hover rounded-md px-3 py-2 text-left"
              >
                <div className="truncate text-sm">{staff.name}</div>
                <div className="text-text-subtle truncate text-2xs">
                  {detail}
                  {staff.roomName ? ` · ${staff.roomName.replace(/ —.*/, "")}` : ""}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
