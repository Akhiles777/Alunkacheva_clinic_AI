"use client";

import { useEffect, useState } from "react";
import {
  addDialogNote,
  cancelDialogTask,
  handoffDialog,
  listColleagues,
  listDialogNotes,
  listDialogTasks,
  removeDialogNote,
  scheduleDialogTask,
  type ColleagueView,
  type DialogNoteView,
  type DialogTaskView,
} from "./dialog-actions";

/**
 * То, чего нет в WhatsApp, — прямо в окне переписки.
 *
 * Заметка «просила перезвонить после 18», передача смены с комментарием,
 * ответ, написанный ночью и уходящий утром, и «вернуться к этому через два
 * дня». Всё это сейчас живёт в голове администратора или в тетради, то есть
 * теряется на первой же пересменке.
 *
 * Панель складывается: в обычной работе она не нужна и не должна занимать
 * место, ради которого сюда смотрят, — саму переписку.
 */

/** Готовые отсрочки: набирать дату руками ради «завтра утром» никто не станет. */
const WHEN = [
  { id: "morning", label: "завтра в 9:00", at: nextMorning },
  { id: "2h", label: "через 2 часа", at: () => new Date(Date.now() + 2 * 3600_000) },
  { id: "tomorrow", label: "через сутки", at: () => new Date(Date.now() + 24 * 3600_000) },
  { id: "2d", label: "через 2 дня", at: () => new Date(Date.now() + 2 * 24 * 3600_000) },
  { id: "week", label: "через неделю", at: () => new Date(Date.now() + 7 * 24 * 3600_000) },
];

function nextMorning(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

export function DialogTools({
  dialogId,
  onChanged,
}: {
  dialogId: string;
  /** Список диалогов обновится: у переписки сменился хозяин или появилось отложенное. */
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"notes" | "handoff" | "later">("notes");
  const [notes, setNotes] = useState<DialogNoteView[]>([]);
  const [tasks, setTasks] = useState<DialogTaskView[]>([]);
  const [colleagues, setColleagues] = useState<ColleagueView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [noteText, setNoteText] = useState("");
  const [toId, setToId] = useState("");
  const [comment, setComment] = useState("");
  const [laterKind, setLaterKind] = useState<"SEND" | "REMIND">("SEND");
  const [laterText, setLaterText] = useState("");
  const [when, setWhen] = useState(WHEN[0].id);

  useEffect(() => {
    let alive = true;
    void Promise.all([listDialogNotes(dialogId), listDialogTasks(dialogId), listColleagues()])
      .then(([n, t, c]) => {
        if (!alive) return;
        setNotes(n);
        setTasks(t);
        setColleagues(c);
      })
      .catch(() => {
        // Панель не загрузилась — она вспомогательная, переписка работает.
        if (alive) setError("Не удалось загрузить заметки и отложенное");
      });
    return () => {
      alive = false;
    };
  }, [dialogId]);

  return (
    <div className="border-border-soft bg-raise flex-none border-b px-5 py-3">
      <div className="mb-2.5 flex flex-wrap gap-1.5">
        {(
          [
            ["notes", `Заметки${notes.length ? ` · ${notes.length}` : ""}`],
            ["handoff", "Передать коллеге"],
            ["later", `Отложить${tasks.length ? ` · ${tasks.length}` : ""}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setTab(id);
              setError(null);
              setDone(null);
            }}
            className={`rounded-md px-2 py-1 text-2xs ${
              tab === id
                ? "bg-accent-tint text-accent-text font-medium"
                : "border-border text-text-muted hover:bg-hover border"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? <p className="text-accent-text mb-2 text-xs">{error}</p> : null}
      {done ? <p className="text-text-muted mb-2 text-xs">{done}</p> : null}

      {tab === "notes" ? (
        <div className="flex flex-col gap-2">
          {/*
            Заметку видят все администраторы и не видит пациент. Так и
            написано рядом с полем: цена ошибки здесь — служебная реплика,
            ушедшая человеку, о котором она написана.
          */}
          <div className="flex flex-wrap items-start gap-2">
            <input
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  save();
                }
              }}
              placeholder="Заметка для коллег: «просила перезвонить после 18»"
              className="border-border-input bg-surface placeholder:text-text-subtle min-w-[200px] flex-1 rounded-md border px-2.5 py-1.5 text-xs outline-none"
            />
            <button
              type="button"
              onClick={save}
              disabled={!noteText.trim()}
              className="bg-accent text-accent-contrast rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-45"
            >
              {/* Не «Записать»: рядом в шапке этим словом записывают на приём. */}
              Сохранить
            </button>
          </div>
          <p className="text-text-subtle text-2xs">Пациент этого не видит. Видят администраторы.</p>
          {notes.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {notes.map((n) => (
                <li key={n.id} className="flex items-baseline gap-2 text-xs">
                  <span className="text-text-subtle num flex-none text-2xs">{n.at}</span>
                  <span className="min-w-0 flex-1">{n.body}</span>
                  {n.author ? <span className="text-text-subtle flex-none text-2xs">{n.author}</span> : null}
                  <button
                    type="button"
                    onClick={() =>
                      void removeDialogNote(n.id).then(() => {
                        setNotes((list) => list.filter((x) => x.id !== n.id));
                      })
                    }
                    className="text-text-subtle hover:text-text flex-none text-2xs"
                  >
                    убрать
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {tab === "handoff" ? (
        <div className="flex flex-col gap-2">
          {colleagues.length === 0 ? (
            <p className="text-text-muted text-xs">
              Передать некому: в клинике один сотрудник с доступом к перепискам.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={toId}
                  onChange={(e) => setToId(e.target.value)}
                  className="border-border-input bg-surface rounded-md border px-2 py-1.5 text-xs outline-none"
                >
                  <option value="">Кому передать</option>
                  {colleagues.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Что сделать: «уточни у Ирины Омаровны и ответь»"
                  className="border-border-input bg-surface placeholder:text-text-subtle min-w-[200px] flex-1 rounded-md border px-2.5 py-1.5 text-xs outline-none"
                />
                <button
                  type="button"
                  onClick={pass}
                  disabled={!toId || !comment.trim()}
                  className="bg-accent text-accent-contrast rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-45"
                >
                  Передать
                </button>
              </div>
              <p className="text-text-subtle text-2xs">
                Коллега получит уведомление и увидит комментарий в заметках. Без комментария
                передача — это та же работа заново.
              </p>
            </>
          )}
        </div>
      ) : null}

      {tab === "later" ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["SEND", "Отправить позже"],
                ["REMIND", "Напомнить мне"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setLaterKind(id)}
                className={`rounded-md px-2 py-1 text-2xs ${
                  laterKind === id
                    ? "bg-accent-tint text-accent-text font-medium"
                    : "border-border text-text-muted hover:bg-hover border"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <textarea
            value={laterText}
            rows={2}
            onChange={(e) => setLaterText(e.target.value)}
            placeholder={
              laterKind === "SEND"
                ? "Текст, который уйдёт пациенту в назначенное время"
                : "О чём напомнить: «спросить про анализы»"
            }
            className="border-border-input bg-surface placeholder:text-text-subtle resize-none rounded-md border px-2.5 py-1.5 text-xs outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              className="border-border-input bg-surface rounded-md border px-2 py-1.5 text-xs outline-none"
            >
              {WHEN.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={later}
              disabled={!laterText.trim()}
              className="bg-accent text-accent-contrast rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-45"
            >
              {laterKind === "SEND" ? "Отложить отправку" : "Поставить напоминание"}
            </button>
          </div>
          <p className="text-text-subtle text-2xs">
            {laterKind === "SEND"
              ? "Уйдёт само, даже если вкладка закрыта: отправку ведёт сервер."
              : "Диалог всплывёт в списке наверху в назначенный момент."}
          </p>
          {tasks.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {tasks.map((t) => (
                <li key={t.id} className="flex items-baseline gap-2 text-xs">
                  <span className="text-text-subtle num flex-none text-2xs">{t.runAt}</span>
                  <span className="text-text-subtle flex-none text-2xs">
                    {t.kind === "SEND" ? "отправить" : "напомнить"}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t.body}</span>
                  {t.status === "FAILED" ? (
                    <span className="text-accent-text flex-none text-2xs">
                      не ушло{t.failureReason ? `: ${t.failureReason}` : ""}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() =>
                      void cancelDialogTask(t.id).then(() => {
                        setTasks((list) => list.filter((x) => x.id !== t.id));
                        onChanged();
                      })
                    }
                    className="text-text-subtle hover:text-text flex-none text-2xs"
                  >
                    отменить
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  function save() {
    const text = noteText.trim();
    if (!text) return;
    setError(null);
    void addDialogNote(dialogId, text)
      .then((res) => {
        if (!res.ok || !res.note) {
          setError(res.error ?? "Заметка не сохранилась");
          return;
        }
        setNotes((list) => [res.note!, ...list]);
        setNoteText("");
        onChanged();
      })
      .catch(() => setError("Заметка не сохранилась — нет связи с сервером"));
  }

  function pass() {
    setError(null);
    void handoffDialog(dialogId, toId, comment)
      .then((res) => {
        if (!res.ok) {
          setError(res.error ?? "Не передалось");
          return;
        }
        const who = colleagues.find((c) => c.id === toId)?.name ?? "коллеге";
        setDone(`Передано: ${who}. Уведомление ушло.`);
        setComment("");
        setToId("");
        void listDialogNotes(dialogId).then(setNotes).catch(() => {});
        onChanged();
      })
      .catch(() => setError("Не передалось — нет связи с сервером"));
  }

  function later() {
    const text = laterText.trim();
    if (!text) return;
    setError(null);
    const at = WHEN.find((w) => w.id === when) ?? WHEN[0];
    void scheduleDialogTask({
      conversationId: dialogId,
      kind: laterKind,
      body: text,
      runAtIso: at.at().toISOString(),
    })
      .then((res) => {
        if (!res.ok) {
          setError(res.error ?? "Не отложилось");
          return;
        }
        setDone(
          laterKind === "SEND"
            ? `Уйдёт ${at.label}. Отменить можно здесь же.`
            : `Напомним ${at.label} — диалог всплывёт в списке.`,
        );
        setLaterText("");
        void listDialogTasks(dialogId).then(setTasks).catch(() => {});
        onChanged();
      })
      .catch(() => setError("Не отложилось — нет связи с сервером"));
  }
}
