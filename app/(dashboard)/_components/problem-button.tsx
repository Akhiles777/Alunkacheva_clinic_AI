"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { reportProblem } from "./usage-actions";

/**
 * «Сообщить о проблеме» — одной кнопкой, из любого экрана.
 *
 * Администратор не пишет разработчику: он молча перестаёт пользоваться тем,
 * что сломалось, и мы узнаём об этом через месяц по косвенным признакам.
 * Кнопка снимает с него всю работу, кроме одной фразы: экран, последнюю
 * ошибку вкладки и версию сборки прикладываем сами — без них половина
 * сообщений «не работает» неразбираема.
 *
 * Живёт в углу и не мешает: открывается по нажатию, закрывается по Esc.
 */
export function ProblemButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  /**
   * Последняя ошибка вкладки. Ловим и необработанные отказы, и то, о чём
   * сказали сами (`clinic:write-failed`): «не сохранилось» человек видит, а
   * причину — нет, и в сообщении о проблеме её не будет.
   */
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) =>
      setLastError(String((e.reason as Error)?.message ?? e.reason).slice(0, 300));
    const onError = (e: ErrorEvent) => setLastError(String(e.message).slice(0, 300));
    const onWrite = (e: Event) => {
      const detail = (e as CustomEvent<{ action: string; reason: string }>).detail;
      if (detail) setLastError(`${detail.action}: ${detail.reason}`.slice(0, 300));
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    window.addEventListener("clinic:write-failed", onWrite);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
      window.removeEventListener("clinic:write-failed", onWrite);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setSent(false);
          setError(null);
        }}
        title="Сообщить о проблеме"
        className="border-border bg-surface text-text-subtle hover:text-text fixed bottom-4 left-4 z-40 rounded-full border px-3 py-1.5 text-2xs shadow-sm max-md:bottom-20"
      >
        Что-то не так?
      </button>
    );
  }

  return (
    <div
      className="overlay-scrim fixed inset-0 z-50 flex items-end justify-center px-4 pb-6 sm:items-center sm:pb-0"
      onMouseDown={() => setOpen(false)}
      role="presentation"
    >
      <div
        className="border-border bg-surface w-full max-w-[440px] rounded-xl border p-5"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Сообщить о проблеме"
      >
        {sent ? (
          <>
            <h2 className="text-md font-medium">Спасибо, записали</h2>
            <p className="text-text-muted mt-1 text-sm leading-snug">
              Сообщение видно владельцу клиники вместе с экраном и ошибкой. Отвечать в
              мессенджере не нужно.
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="bg-accent text-accent-contrast mt-4 rounded-md px-3 py-1.5 text-sm font-medium"
            >
              Закрыть
            </button>
          </>
        ) : (
          <>
            <h2 className="text-md font-medium">Что-то не так?</h2>
            <p className="text-text-muted mt-1 text-sm leading-snug">
              Напишите одной фразой, что случилось. Экран и последнюю ошибку приложим сами.
            </p>
            <textarea
              value={text}
              rows={3}
              autoFocus
              onChange={(e) => setText(e.target.value)}
              placeholder="Например: не отправляется фотография пациенту"
              className="border-border-input bg-surface placeholder:text-text-subtle mt-3 w-full resize-none rounded-md border px-3 py-2 text-sm outline-none"
            />
            {error ? <p className="text-accent-text mt-2 text-xs">{error}</p> : null}
            <p className="text-text-subtle mt-2 text-2xs leading-snug">
              Приложим: экран «{pathname}»
              {lastError ? " и последнюю ошибку вкладки" : ""}. Переписка не отправляется.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={!text.trim()}
                onClick={() =>
                  void reportProblem({
                    text,
                    screen: pathname,
                    lastError,
                    build: process.env.NEXT_PUBLIC_BUILD_ID ?? null,
                  })
                    .then((res) => {
                      if (!res.ok) {
                        setError(res.error ?? "Не отправилось");
                        return;
                      }
                      setText("");
                      setSent(true);
                    })
                    .catch(() => setError("Не отправилось — нет связи с сервером"))
                }
                className="bg-accent text-accent-contrast rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-45"
              >
                Отправить
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-text-subtle hover:text-text text-sm"
              >
                Отмена
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
