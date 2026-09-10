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
import { noteUse } from "../_components/usage-actions";
import { closeDialogs } from "@/app/_data/store";

/**
 * Заметка, передача коллеге и отложенная отправка — строкой под перепиской.
 *
 * Сначала это была панель с вкладками над разговором. Вкладки — вид меню, а
 * меню в рабочем окне забирает и место, и внимание: администратор смотрит на
 * переписку, а не на органы управления. Ими пользуются несколько раз за смену,
 * поэтому здесь — короткая подпись под полем ввода; нажал слово, под ним
 * раскрылась одна форма, закончил — свернулась.
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

type Panel = "notes" | "handoff" | "later" | null;

export function DialogTools({
  dialogId,
  onChanged,
}: {
  dialogId: string;
  /** Список диалогов обновится: у переписки сменился хозяин или появилось отложенное. */
  onChanged: () => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
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

  /**
   * Считаем заметки и отложенное сразу: число в подписи говорит, есть ли там
   * что-то, и без него подпись — просто ссылка, по которой надо сходить.
   */
  useEffect(() => {
    let alive = true;
    void Promise.all([listDialogNotes(dialogId), listDialogTasks(dialogId)])
      .then(([n, t]) => {
        if (!alive) return;
        setNotes(n);
        setTasks(t);
      })
      .catch(() => {
        // Не загрузилось — переписка работает, подпись просто без чисел.
      });
    return () => {
      alive = false;
    };
  }, [dialogId]);

  /** Коллеги нужны только для передачи — за ними ходим, когда открыли форму. */
  useEffect(() => {
    if (panel !== "handoff" || colleagues.length > 0) return;
    let alive = true;
    void listColleagues()
      .then((c) => alive && setColleagues(c))
      .catch(() => alive && setError("Не удалось получить список сотрудников"));
    return () => {
      alive = false;
    };
  }, [panel, colleagues.length]);

  function toggle(next: Panel) {
    setPanel((cur) => (cur === next ? null : next));
    setError(null);
    setDone(null);
  }

  return (
    <div className="border-border-soft flex-none border-t px-5 py-1.5">
      {/* Подпись, а не вкладки: три слова мелким шрифтом под полем ввода. */}
      <div className="text-text-subtle flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
        <Word active={panel === "notes"} onClick={() => toggle("notes")}>
          Заметка{notes.length > 0 ? ` · ${notes.length}` : ""}
        </Word>
        <Word active={panel === "handoff"} onClick={() => toggle("handoff")}>
          Передать коллеге
        </Word>
        <Word active={panel === "later"} onClick={() => toggle("later")}>
          Отложить{tasks.length > 0 ? ` · ${tasks.length}` : ""}
        </Word>
        {/*
          Закрыть разговор. Раньше это делалось галочками в списке; галочки
          убраны, а закрывать надо: иначе разобранная переписка висит в списке
          вечно. Здесь же, в подписи под перепиской, — по одному разговору за
          раз, из того места, где человек его и закончил.
        */}
        <Word active={false} onClick={close}>
          Закрыть разговор
        </Word>
        {done ? <span className="text-text-muted">{done}</span> : null}
        {error ? <span className="text-accent-text">{error}</span> : null}
      </div>

      {panel === "notes" ? (
        <div className="mt-2 mb-1 flex flex-col gap-2">
          <div className="flex flex-wrap items-start gap-2">
            <input
              value={noteText}
              autoFocus
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  save();
                }
                if (e.key === "Escape") setPanel(null);
              }}
              placeholder="Для коллег, не для пациента: «просила перезвонить после 18»"
              className="border-border-input bg-surface placeholder:text-text-subtle min-w-[200px] flex-1 rounded-md border px-2.5 py-1.5 text-xs outline-none"
            />
            <button
              type="button"
              onClick={save}
              disabled={!noteText.trim()}
              className="bg-accent text-accent-contrast rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-45"
            >
              Сохранить
            </button>
          </div>
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
                        onChanged();
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

      {panel === "handoff" ? (
        <div className="mt-2 mb-1 flex flex-col gap-2">
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
                Коллега получит уведомление, комментарий останется в заметках.
              </p>
            </>
          )}
        </div>
      ) : null}

      {panel === "later" ? (
        <div className="mt-2 mb-1 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={laterKind}
              onChange={(e) => setLaterKind(e.target.value as "SEND" | "REMIND")}
              className="border-border-input bg-surface rounded-md border px-2 py-1.5 text-xs outline-none"
            >
              <option value="SEND">Отправить пациенту позже</option>
              <option value="REMIND">Напомнить мне</option>
            </select>
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
              {laterKind === "SEND" ? "Отложить" : "Напомнить"}
            </button>
          </div>
          <textarea
            value={laterText}
            rows={2}
            autoFocus
            onChange={(e) => setLaterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPanel(null);
            }}
            placeholder={
              laterKind === "SEND"
                ? "Текст, который уйдёт пациенту в назначенное время"
                : "О чём напомнить: «спросить про анализы»"
            }
            className="border-border-input bg-surface placeholder:text-text-subtle resize-none rounded-md border px-2.5 py-1.5 text-xs outline-none"
          />
          <p className="text-text-subtle text-2xs">
            {laterKind === "SEND"
              ? "Уйдёт само, даже если вкладка закрыта."
              : "Диалог всплывёт наверху списка в назначенный момент."}
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

  function close() {
    setError(null);
    closeDialogs([dialogId]);
    setDone("разговор закрыт — вернётся сам, если пациент напишет");
    onChanged();
  }

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
        void noteUse("note");
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
        void noteUse("handoff");
        setDone(`передано: ${who}`);
        setComment("");
        setToId("");
        setPanel(null);
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
        void noteUse("later");
        setDone(laterKind === "SEND" ? `уйдёт ${at.label}` : `напомним ${at.label}`);
        setLaterText("");
        setPanel(null);
        void listDialogTasks(dialogId).then(setTasks).catch(() => {});
        onChanged();
      })
      .catch(() => setError("Не отложилось — нет связи с сервером"));
  }
}

/** Слово-кнопка в подписи: не выглядит органом управления, пока не нужно. */
function Word({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`hover:text-text ${active ? "text-accent-text font-medium" : ""}`}
    >
      {children}
    </button>
  );
}
