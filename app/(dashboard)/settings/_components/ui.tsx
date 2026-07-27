"use client";

import { useState, type ReactNode } from "react";

/** Заголовок секции настроек + описание одной строкой. */
export function SettingsHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
      <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">{title}</h1>
      <p className="text-text-muted mt-1.5 max-w-[70ch] text-xs leading-relaxed">{description}</p>
    </div>
  );
}

/** Карточка-группа полей. */
export function Group({
  title,
  hint,
  children,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-border bg-surface rounded-xl border">
      {title ? (
        <header className="border-border-soft border-b px-5 py-3">
          <h2 className="text-sm font-medium">{title}</h2>
          {hint ? <p className="text-text-subtle mt-0.5 text-xs">{hint}</p> : null}
        </header>
      ) : null}
      <div className="flex flex-col gap-4 px-5 py-4">{children}</div>
    </section>
  );
}

/** Строка «подпись — контрол». */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-1.5 md:grid-cols-[200px_minmax(0,1fr)] md:items-center md:gap-4">
      <label htmlFor={htmlFor} className="text-sm">
        {label}
        {hint ? <span className="text-text-subtle mt-0.5 block text-2xs">{hint}</span> : null}
      </label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/**
 * Ввод времени в 24-часовом формате. Не нативный `type="time"`: он показывает
 * AM/PM по локали браузера — для клиники в РФ это чужеродно, а моноширинный
 * 24 ч — часть языка. Родитель хранит минуты, инпут — только он их и меняет.
 */
export function TimeInput({
  minute,
  onChange,
  ariaLabel,
}: {
  minute: number;
  onChange: (minute: number) => void;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(() => hhmm(minute));

  function commit(value: string) {
    setText(value);
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!m) return;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return;
    onChange(h * 60 + min);
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={text}
      onChange={(e) => commit(e.target.value)}
      onBlur={() => setText(hhmm(minute))}
      className="border-border-input bg-surface num w-[76px] rounded-md border px-2.5 py-1.5 text-sm outline-none"
    />
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`border-border-input bg-surface placeholder:text-text-subtle w-full rounded-md border px-3 py-2 text-sm outline-none ${props.className ?? ""}`}
    />
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`border-border-input bg-surface placeholder:text-text-subtle w-full resize-y rounded-md border px-3 py-2 text-sm leading-relaxed outline-none ${props.className ?? ""}`}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-none items-center rounded-pill transition-colors ${
        checked ? "bg-accent" : "bg-border-strong"
      }`}
    >
      <span
        className={`bg-surface inline-block h-4 w-4 rounded-full transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="border-border inline-flex overflow-hidden rounded-md border">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 text-sm ${i > 0 ? "border-border border-l" : ""} ${
            value === opt.value ? "bg-accent-tint text-accent-text font-medium" : "text-text-muted hover:bg-hover"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Панель сохранения: кнопка + подтверждение/ошибка. Сохранение мок-стора
 * синхронное, но показываем «Сохранено» — так же, как поведёт себя реальный
 * Server Action.
 */
export function SaveBar({
  onSave,
  error,
}: {
  onSave: () => void;
  error?: string | null;
}) {
  const [state, setState] = useState<"idle" | "saved">("idle");

  return (
    <div className="flex items-center gap-3 pt-1">
      <button
        type="button"
        onClick={() => {
          if (error) return;
          onSave();
          setState("saved");
          setTimeout(() => setState("idle"), 2000);
        }}
        disabled={Boolean(error)}
        className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45"
      >
        Сохранить
      </button>
      {error ? (
        <span className="text-accent-text text-sm">{error}</span>
      ) : state === "saved" ? (
        <span className="text-text-muted text-sm">Сохранено</span>
      ) : null}
    </div>
  );
}

/** Заглушка «нет прав» — гейт по EDIT_SETTINGS (§9). */
export function NoAccess() {
  return (
    <div className="px-7 py-8 max-md:px-5">
      <div className="border-border bg-surface max-w-[560px] rounded-xl border p-5">
        <p className="text-md font-medium">Недостаточно прав</p>
        <p className="text-text-muted mt-2 text-sm leading-relaxed">
          Менять настройки может владелец клиники. Обратитесь к нему, если нужно
          изменить параметр.
        </p>
      </div>
    </div>
  );
}
