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
import { VoicePlayer, VoiceRecorder } from "./voice-message";
import { patientTags, primaryPhone, useDb } from "@/app/_data/store";

/**
 * Внутренний чат клиники. Устройство намеренно простое (решение заказчика,
 * август 2026): один общий канал и плоский список всех сотрудников — кто
 * заведён в настройках, тот и в списке. Никаких групп, ролевых веток и
 * прикреплений: служебная переписка, а не второй инбокс.
 */

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
    MANAGER: "управляющий",
    DOCTOR: "врач",
  };
  return labels[role] ?? role.toLowerCase();
}

function initials(name: string): string {
  return name.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("");
}

function firstVoice(attachments: InternalChatAttachment[]): InternalChatAttachment | null {
  return attachments.find((a) => a.kind === "voice" && a.dataUrl) ?? null;
}

/**
 * Отметка доставки: одна галочка — сообщение сохранено и доставлено, две —
 * собеседник открыл чат после него. В общем канале вместо галочек показываем,
 * сколько человек прочитали: там «прочитано» одним ничего не значит.
 */
function ReadMark({ message }: { message: InternalChatState["messages"][number] }) {
  if (message.recipients === 0) {
    return <span className="text-text-subtle" title="Пока некому прочитать">✓</span>;
  }
  if (message.recipients === 1) {
    const read = message.readBy > 0;
    return (
      <span className={read ? "text-accent-text" : "text-text-subtle"} title={read ? "Прочитано" : "Доставлено"}>
        {read ? "✓✓" : "✓"}
      </span>
    );
  }
  return (
    <span
      className={message.readBy > 0 ? "text-accent-text" : "text-text-subtle"}
      title={`Прочитали ${message.readBy} из ${message.recipients}`}
    >
      {message.readBy > 0 ? `✓✓ ${message.readBy}/${message.recipients}` : "✓"}
    </span>
  );
}

export function InternalStaffChat({ compact = false }: { compact?: boolean }) {
  const db = useDb();
  const [state, setState] = useState<InternalChatState | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [shareId, setShareId] = useState("");
  const [isPending, startTransition] = useTransition();
  const endRef = useRef<HTMLDivElement | null>(null);

  const sharePatient = db.patients.find((p) => p.id === shareId) ?? null;
  const activeCourse = sharePatient?.courses.find((c) => c.status !== "done");

  const activeRoom = state?.rooms.find((r) => r.id === state.activeRoomId) ?? null;
  const generalRoom = state?.rooms.find((r) => r.kind === "GENERAL") ?? null;
  const peers = useMemo(() => state?.staff.filter((s) => !s.isSelf) ?? [], [state]);

  /** Непрочитанные по личному диалогу с конкретным сотрудником. */
  const unreadByPeer = useMemo(() => {
    const map = new Map<string, number>();
    for (const room of state?.rooms ?? []) {
      if (room.kind === "DIRECT" && room.peerId) map.set(room.peerId, room.unread);
    }
    return map;
  }, [state]);

  const activePeerId = activeRoom?.kind === "DIRECT" ? activeRoom.peerId : null;

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

  // Тихое обновление: без него чужие сообщения и отметки прочтения не
  // появлялись до следующего действия — для чата это выглядело как «не дошло».
  const activeRoomId = state?.activeRoomId;
  useEffect(() => {
    if (!activeRoomId) return;
    let alive = true;
    const tick = () => {
      getInternalChatState(activeRoomId)
        .then((next) => {
          if (alive) setState(next);
        })
        .catch(() => {});
    };
    const timer = setInterval(tick, 7000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [activeRoomId]);

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

  return (
    <section
      className={`border-border bg-surface flex min-h-0 rounded-xl border ${
        compact ? "h-[460px]" : "h-full"
      }`}
    >
      <aside className="border-border-soft flex w-[248px] flex-none flex-col border-r max-md:hidden">
        <div className="flex-1 overflow-auto p-2">
          {generalRoom ? (
            <button
              type="button"
              onClick={() => run(() => getInternalChatState(generalRoom.id))}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${
                generalRoom.id === state?.activeRoomId
                  ? "bg-nav-active text-accent-text font-medium"
                  : "text-text-muted hover:bg-hover"
              }`}
            >
              <span aria-hidden className="flex-none opacity-70">#</span>
              <span className="min-w-0 flex-1 truncate">Общий чат</span>
              {generalRoom.unread > 0 ? (
                <span className="num bg-chip-strong text-text-muted rounded-pill px-[7px] py-px text-2xs">
                  {generalRoom.unread}
                </span>
              ) : null}
            </button>
          ) : (
            <div className="skeleton h-9 rounded-md" />
          )}

          <div className="text-text-subtle mt-4 px-3 pb-1 text-2xs">Сотрудники</div>
          <div className="flex flex-col gap-0.5">
            {peers.length === 0 ? (
              <p className="text-text-subtle px-3 py-2 text-2xs">
                Других сотрудников нет. Добавьте их в «Настройки → Сотрудники».
              </p>
            ) : (
              peers.map((person) => {
                const unread = unreadByPeer.get(person.id) ?? 0;
                const active = person.id === activePeerId;
                return (
                  <button
                    key={person.id}
                    type="button"
                    onClick={() => run(() => openDirectChat(person.id))}
                    className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left ${
                      active ? "bg-nav-active" : "hover:bg-hover"
                    }`}
                  >
                    <span className="bg-ink-avatar text-text-muted flex h-7 w-7 flex-none items-center justify-center rounded-full text-2xs font-medium">
                      {initials(person.name) || "?"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm ${active ? "text-accent-text font-medium" : ""}`}>
                        {person.name}
                      </span>
                      <span className="text-text-subtle block truncate text-2xs">
                        {person.specialty || roleLabel(person.role)}
                      </span>
                    </span>
                    {unread > 0 ? (
                      <span className="num bg-chip-strong text-text-muted rounded-pill px-[7px] py-px text-2xs">
                        {unread}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
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
            {/* На телефоне список слева скрыт — выбор чата через один select. */}
            {state ? (
              <select
                value={activeRoom?.kind === "DIRECT" ? `peer:${activePeerId}` : "general"}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value.startsWith("peer:")) run(() => openDirectChat(value.slice(5)));
                  else if (generalRoom) run(() => getInternalChatState(generalRoom.id));
                }}
                aria-label="Выбрать чат"
                className="border-border-input bg-surface hidden max-w-[170px] rounded-md border px-2 py-1.5 text-xs outline-none max-md:block"
              >
                <option value="general">Общий чат</option>
                {peers.map((person) => (
                  <option key={person.id} value={`peer:${person.id}`}>
                    {person.name}
                  </option>
                ))}
              </select>
            ) : null}
            {isPending ? <span className="text-text-subtle text-2xs">синхронизация…</span> : null}
          </div>
        </div>

        {error ? (
          <div className="border-border-soft bg-hover text-text-muted border-b px-5 py-2 text-xs">{error}</div>
        ) : null}

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
                      {message.mine && !message.deleted ? <ReadMark message={message} /> : null}
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
                          {voice ? <VoicePlayer attachment={voice} /> : null}
                          {/* Карточки пациентов и курсов больше не прикрепляются,
                              но старые сообщения обязаны читаться. */}
                          {message.attachments
                            .filter((a) => a.kind !== "voice")
                            .map((attachment, index) => (
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
          {attachOpen ? (
            <div className="border-border-soft mb-2 flex flex-wrap items-center gap-2 rounded-lg border p-2">
              <select
                value={shareId}
                onChange={(e) => setShareId(e.target.value)}
                aria-label="Клиент для отправки"
                className="border-border-input bg-surface min-w-0 flex-1 rounded-md border px-2.5 py-1.5 text-sm outline-none"
              >
                <option value="">выберите клиента…</option>
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
                  send("", [
                    {
                      kind: "patient",
                      label: sharePatient.name,
                      detail: `${primaryPhone(sharePatient)?.pretty ?? "нет номера"} · ${
                        patientTags(sharePatient).join(", ") || "без меток"
                      }`,
                      patientId: sharePatient.id,
                    },
                  ]);
                  setShareId("");
                  setAttachOpen(false);
                }}
                className="border-border text-text-muted hover:bg-hover flex-none rounded-md border px-2.5 py-1.5 text-xs disabled:opacity-45"
              >
                Карточка
              </button>
              <button
                type="button"
                disabled={!activeCourse || !state}
                onClick={() => {
                  if (!sharePatient || !activeCourse) return;
                  send("", [
                    {
                      kind: "course",
                      label: `${activeCourse.title} — ${sharePatient.name}`,
                      // «4/10» — состоявшиеся сеансы; записанные впереди
                      // называем отдельно, иначе курс выглядит брошенным.
                      detail: `${activeCourse.used}/${activeCourse.total}${
                        activeCourse.booked ? `, записан ещё на ${activeCourse.booked}` : ""
                      }, ${activeCourse.status === "stalled" ? "выпал из графика" : "идёт по курсу"}`,
                      patientId: sharePatient.id,
                    },
                  ]);
                  setShareId("");
                  setAttachOpen(false);
                }}
                className="border-border text-text-muted hover:bg-hover flex-none rounded-md border px-2.5 py-1.5 text-xs disabled:opacity-45"
              >
                Курс
              </button>
            </div>
          ) : null}

          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const next = text.trim();
              if (!next) return;
              setText("");
              send(next);
            }}
          >
            <button
              type="button"
              onClick={() => setAttachOpen((v) => !v)}
              disabled={!state}
              aria-label="Прикрепить клиента"
              title="Прикрепить клиента или курс"
              className={`flex h-9 w-9 flex-none items-center justify-center rounded-full border text-base disabled:opacity-45 ${
                attachOpen ? "border-accent bg-accent text-accent-contrast" : "border-border text-text-muted hover:bg-hover"
              }`}
            >
              <span aria-hidden>📎</span>
            </button>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Сообщение коллегам…"
              className="border-border-input bg-surface placeholder:text-text-subtle min-w-0 flex-1 rounded-md border px-3 py-2 text-sm outline-none"
            />
            {/* Микрофон справа, рядом с отправкой — как в мессенджерах. */}
            <VoiceRecorder
              disabled={!state}
              onError={setError}
              onRecorded={(voice) =>
                send("", [
                  {
                    kind: "voice",
                    dataUrl: voice.dataUrl,
                    mimeType: voice.mimeType,
                    durationSec: voice.durationSec,
                    peaks: voice.peaks,
                  },
                ])
              }
            />
            <button
              type="submit"
              disabled={!text.trim() || !state}
              className="bg-accent text-accent-contrast hover:bg-accent-hover flex-none rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45 max-md:px-3"
            >
              <span className="max-md:hidden">Отправить</span>
              <span aria-hidden className="hidden max-md:inline">
                ↑
              </span>
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
