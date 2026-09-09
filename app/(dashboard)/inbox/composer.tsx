"use client";

import { useEffect, useRef, useState } from "react";
import { checkFile, willSplit, TEXT_LIMIT, type SendChannel } from "@/lib/media/limits";
import { draftOf, setDraft, type OutgoingAttachment } from "@/app/_data/store";

/**
 * Поле ввода администратора: текст, файлы, голосовое.
 *
 * Пока отсюда нельзя было отправить фотографию или голосовое, администратор
 * брал телефон и отвечал в WhatsApp сам — а платформа переставала знать о
 * половине разговора. Это и есть главная причина возврата к прежнему
 * инструменту, поэтому здесь собрано всё, что человек делает в мессенджере.
 *
 * Что решено и почему:
 *
 *   — файл сначала загружается, потом показывается предпросмотром, и только
 *     по «Отправить» уходит пациенту. Отправка «сразу по выбору» не даёт
 *     передумать, а передумывают часто: выбрали не тот снимок;
 *   — пределы проверяются ДО загрузки, нашим кодом (`lib/media/limits`), и
 *     называются словами: «WhatsApp не принимает файл больше 5 МБ». Узнавать
 *     это от провайдера после отправки — значит узнавать, когда исправить
 *     уже нечего;
 *   — черновик привязан к диалогу. Раньше поле было общим на все переписки:
 *     набранное одному пациенту оставалось на экране у другого и уходило ему.
 */

/** Дольше этого голосовое не пишем: длинные никто не слушает. */
const MAX_VOICE_SEC = 180;

export interface ComposerProps {
  dialogId: string;
  channel: SendChannel;
  /** На какое сообщение отвечаем; null — обычная отправка. */
  replyTo: { id: string; preview: string } | null;
  onCancelReply: () => void;
  onSend: (text: string, files: OutgoingAttachment[]) => void;
  quickReplies: string[];
}

interface Picked extends OutgoingAttachment {
  /** Пока файл грузится, показываем его же, но серым и без «Отправить». */
  uploading?: boolean;
}

/** Часто используемые — не библиотека на полмегабайта ради десяти значков. */
const EMOJI = ["🙂", "👍", "🙏", "❤️", "😊", "✅", "❗", "📍", "📞", "🕒", "💊", "🩺"];

export function Composer({
  dialogId,
  channel,
  replyTo,
  onCancelReply,
  onSend,
  quickReplies,
}: ComposerProps) {
  const [text, setText] = useState(() => draftOf(dialogId));
  const [files, setFiles] = useState<Picked[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  /**
   * Черновик переезжает вместе с диалогом.
   *
   * Сбрасывать состояние эффектом не нужно и вредно: компонент пересоздаётся
   * вместе со сменой переписки (`key` в инбоксе), поэтому начальное значение
   * берётся из черновика этого диалога, а приложенные файлы не переходят к
   * другому пациенту сами собой. Набранное для одного человека, оказавшееся в
   * поле у другого, — это отправленное не тому.
   */
  useEffect(() => {
    setDraft(dialogId, text);
  }, [dialogId, text]);

  /** Высота поля по содержимому: длинный ответ не должен печататься в щель. */
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  async function upload(list: File[]) {
    setError(null);
    for (const file of list) {
      const verdict = checkFile({
        channel,
        mimeType: file.type,
        fileName: file.name,
        sizeBytes: file.size,
      });
      if (!verdict.ok) {
        setError(verdict.reason ?? "Такой файл отправить нельзя");
        continue;
      }
      const temp: Picked = {
        mediaId: `pending-${Math.random().toString(36).slice(2)}`,
        kind: verdict.kind,
        label: file.name || verdict.kind,
        href: "",
        fileName: file.name,
        uploading: true,
      };
      setFiles((prev) => [...prev, temp]);

      const form = new FormData();
      form.append("file", file);
      form.append("channel", channel);
      try {
        const res = await fetch("/api/upload", { method: "POST", body: form });
        const data = (await res.json()) as {
          id?: string;
          kind?: string;
          fileName?: string | null;
          href?: string;
          durationSec?: number | null;
          error?: string;
        };
        if (!res.ok || !data.id || !data.href) {
          setFiles((prev) => prev.filter((f) => f.mediaId !== temp.mediaId));
          setError(data.error ?? "Файл не загрузился");
          continue;
        }
        setFiles((prev) =>
          prev.map((f) =>
            f.mediaId === temp.mediaId
              ? {
                  mediaId: data.id!,
                  kind: data.kind ?? verdict.kind,
                  label: data.fileName ?? file.name ?? "файл",
                  href: data.href!,
                  fileName: data.fileName ?? file.name,
                  durationSec: data.durationSec ?? undefined,
                }
              : f,
          ),
        );
      } catch {
        setFiles((prev) => prev.filter((f) => f.mediaId !== temp.mediaId));
        setError("Файл не дошёл до сервера — проверьте связь и попробуйте ещё раз");
      }
    }
  }

  function submit() {
    const ready = files.filter((f) => !f.uploading);
    if (files.some((f) => f.uploading)) {
      setError("Файл ещё загружается — секунду");
      return;
    }
    if (!text.trim() && ready.length === 0) return;
    onSend(text, ready);
    setText("");
    setDraft(dialogId, "");
    setFiles([]);
    setError(null);
  }

  function insert(sym: string) {
    const el = areaRef.current;
    if (!el) {
      setText((t) => t + sym);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    setText(text.slice(0, start) + sym + text.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + sym.length;
    });
  }

  const parts = willSplit(text);

  return (
    <div
      className={`border-border flex-none border-t px-5 py-3 ${dragging ? "bg-accent-tint" : ""}`}
      onDragOver={(e) => {
        // Перетаскивание файла прямо в переписку: так это делают в мессенджере.
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void upload([...e.dataTransfer.files]);
      }}
    >
      {replyTo ? (
        <div className="border-accent-border bg-accent-tint mb-2 flex items-start gap-2 rounded-md border px-2.5 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="text-accent-text text-2xs font-medium">В ответ на</div>
            <div className="text-text-muted truncate text-xs">{replyTo.preview}</div>
          </div>
          <button
            type="button"
            onClick={onCancelReply}
            className="text-text-subtle hover:text-text flex-none text-xs"
            aria-label="Отменить ответ"
          >
            ✕
          </button>
        </div>
      ) : null}

      {quickReplies.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {quickReplies.map((q) => (
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
      ) : null}

      {files.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {files.map((f) => (
            <div
              key={f.mediaId}
              className={`border-border bg-surface flex items-center gap-2 rounded-md border px-2 py-1.5 ${
                f.uploading ? "opacity-60" : ""
              }`}
            >
              {f.kind === "photo" && f.href ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={f.href} alt="" className="h-9 w-9 rounded object-cover" />
              ) : (
                <span className="text-text-subtle text-2xs">{f.kind === "voice" ? "🎤" : "📄"}</span>
              )}
              <span className="max-w-[160px] truncate text-xs">{f.label}</span>
              {f.uploading ? (
                <span className="text-text-subtle text-2xs">загружается…</span>
              ) : (
                <button
                  type="button"
                  onClick={() => setFiles((prev) => prev.filter((x) => x.mediaId !== f.mediaId))}
                  className="text-text-subtle hover:text-text text-xs"
                  aria-label="Убрать вложение"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p className="text-accent-text mb-2 text-xs">{error}</p> : null}
      {parts > 1 ? (
        <p className="text-text-muted mb-2 text-2xs">
          Длинное сообщение: уйдёт {parts} частями по {TEXT_LIMIT} знаков.
        </p>
      ) : null}

      {emojiOpen ? (
        <div className="border-border bg-surface mb-2 flex flex-wrap gap-1 rounded-md border p-2">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => insert(e)}
              className="hover:bg-hover rounded px-1.5 py-0.5 text-base"
            >
              {e}
            </button>
          ))}
        </div>
      ) : null}

      {/*
        На узком экране поле ввода занимает строку целиком, а кнопки уходят
        под него: в один ряд текстовое поле сжималось до сотни точек, и
        печатать в него было нельзя. На широком — всё в одну строку, как было.
      */}
      <div className="flex flex-wrap items-end gap-2">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void upload([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          title="Прикрепить файл"
          className="border-border text-text-muted hover:bg-hover order-2 flex-none rounded-md border px-2.5 py-2 text-sm md:order-1"
        >
          📎
        </button>
        <button
          type="button"
          onClick={() => setEmojiOpen((v) => !v)}
          title="Смайлы"
          className="border-border text-text-muted hover:bg-hover order-2 flex-none rounded-md border px-2.5 py-2 text-sm md:order-1"
        >
          🙂
        </button>
        <VoiceButton
          className="order-2 md:order-1"
          channel={channel}
          onRecorded={(file) => void upload([file])}
          onError={setError}
        />
        <textarea
          ref={areaRef}
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            /**
             * Enter отправляет, Shift+Enter переносит строку — как в
             * мессенджере. Cmd/Ctrl+Enter тоже отправляет: так привыкли те,
             * кто пришёл из почты.
             */
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            // Скриншот из буфера: администратор копирует его постоянно.
            const pasted = [...e.clipboardData.files];
            if (pasted.length > 0) {
              e.preventDefault();
              void upload(pasted);
            }
          }}
          placeholder="Ответить вручную…  Enter — отправить, Shift+Enter — новая строка"
          className="border-border-input bg-surface placeholder:text-text-subtle order-1 max-h-40 min-h-[38px] grow basis-full resize-none rounded-md border px-3 py-2 text-sm outline-none md:order-2 md:basis-0 md:min-w-[160px]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim() && files.filter((f) => !f.uploading).length === 0}
          className="bg-accent text-accent-contrast hover:bg-accent-hover order-3 ml-auto flex-none rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45 md:ml-0"
        >
          Отправить
        </button>
      </div>
    </div>
  );
}

/**
 * Запись голосового.
 *
 * Переключателем, а не удержанием кнопки: на десктопе держать мышь полторы
 * минуты неудобно, а случайно отпустить — легко, и запись пропадёт вместе с
 * тем, что человек уже сказал. Нажали — пишем, нажали ещё раз — остановили и
 * показали предпросмотр: послушать, отправить или удалить.
 *
 * Отказ микрофона объясняем словами. «NotAllowedError» человеку не говорит
 * ничего, а решение у него ровно одно: разрешить микрофон в адресной строке.
 */
function VoiceButton({
  channel,
  onRecorded,
  onError,
  className = "",
}: {
  channel: SendChannel;
  onRecorded: (file: File) => void;
  onError: (message: string | null) => void;
  className?: string;
}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [preview, setPreview] = useState<{ url: string; file: File; seconds: number } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearInterval(timer.current);
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
      if (preview) URL.revokeObjectURL(preview.url);
    };
    // Размонтирование: чистим и микрофон, и ссылку на запись.
  }, [preview]);

  async function start() {
    onError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      onError("Этот браузер не умеет записывать звук — отправьте текстом.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = (e as Error).name;
      onError(
        name === "NotAllowedError"
          ? "Микрофон запрещён. Нажмите значок замка слева в адресной строке и разрешите микрофон для этого сайта."
          : name === "NotFoundError"
            ? "Микрофон не найден — проверьте, что он подключён."
            : "Не удалось включить микрофон.",
      );
      return;
    }

    const rec = new MediaRecorder(stream);
    chunks.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
      if (blob.size === 0) {
        onError("Запись не получилась — попробуйте ещё раз.");
        return;
      }
      const ext = (rec.mimeType || "audio/webm").includes("ogg") ? "ogg" : "webm";
      const file = new File([blob], `voice.${ext}`, { type: blob.type });
      setPreview({ url: URL.createObjectURL(blob), file, seconds });
    };
    rec.start();
    recorder.current = rec;
    setSeconds(0);
    setRecording(true);
    timer.current = setInterval(() => {
      setSeconds((s) => {
        // Дольше трёх минут не пишем: длинное голосовое никто не слушает, а
        // провайдер такой файл может и не принять.
        if (s + 1 >= MAX_VOICE_SEC) stop();
        return s + 1;
      });
    }, 1000);
  }

  function stop() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setRecording(false);
    recorder.current?.state === "recording" && recorder.current.stop();
  }

  if (preview) {
    return (
      <div className={`border-border bg-surface flex flex-none items-center gap-2 rounded-md border px-2 py-1.5 ${className}`}>
        <audio controls src={preview.url} className="h-8 max-w-[180px]" />
        <button
          type="button"
          onClick={() => {
            onRecorded(preview.file);
            URL.revokeObjectURL(preview.url);
            setPreview(null);
          }}
          className="bg-accent text-accent-contrast rounded-md px-2.5 py-1 text-xs font-medium"
        >
          Приложить
        </button>
        <button
          type="button"
          onClick={() => {
            URL.revokeObjectURL(preview.url);
            setPreview(null);
          }}
          className="text-text-subtle hover:text-text text-xs"
        >
          Удалить
        </button>
      </div>
    );
  }

  if (channel === "INSTAGRAM") return null;

  return (
    <button
      type="button"
      onClick={() => (recording ? stop() : void start())}
      title={recording ? "Остановить запись" : "Записать голосовое"}
      className={`${className} flex-none rounded-md border px-2.5 py-2 text-sm ${
        recording
          ? "border-accent-border bg-accent-tint text-accent-text"
          : "border-border text-text-muted hover:bg-hover"
      }`}
    >
      {recording ? (
        <span className="num">
          ● {String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}
        </span>
      ) : (
        "🎤"
      )}
    </button>
  );
}
