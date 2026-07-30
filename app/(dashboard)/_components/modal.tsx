"use client";

import { useEffect, type ReactNode } from "react";

/**
 * Центрированное модальное окно дашборда: scrim, закрытие по Esc и клику вне,
 * прокрутка внутри. Без теней (§9, DESIGN.md) — граница + overlay-scrim.
 * На узких экранах занимает почти весь экран.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  children,
  size = "md",
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  size?: "md" | "lg";
  labelledBy?: string;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const maxW = size === "lg" ? "max-w-[720px]" : "max-w-[520px]";

  return (
    <div
      className="overlay-scrim fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 py-[6vh] max-md:p-0"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className={`bg-surface border-border flex max-h-[88vh] w-full ${maxW} flex-col rounded-2xl border max-md:h-full max-md:max-h-none max-md:rounded-none`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        aria-labelledby={labelledBy}
      >
        {title || description ? (
          <div className="border-border flex flex-none items-start justify-between gap-3 border-b px-5 py-4">
            <div className="min-w-0">
              {title ? <div className="text-md font-medium">{title}</div> : null}
              {description ? <div className="text-text-subtle mt-0.5 text-xs">{description}</div> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="text-text-subtle hover:text-text -mr-1 flex-none rounded-sm px-1 text-lg leading-none"
            >
              ×
            </button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto px-5 py-5">{children}</div>
        {footer ? (
          <div className="border-border flex flex-none items-center justify-end gap-3 border-t px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
