"use client";

import { useState, useTransition } from "react";
import { Group, TextInput, Toggle } from "../_components/ui";
import { saveSources, type SourceRow } from "./actions";

const SOURCE_KINDS: { value: SourceRow["kind"]; label: string }[] = [
  { value: "MESSENGER", label: "Мессенджер" },
  { value: "PHONE", label: "Звонок" },
  { value: "WEB", label: "Сайт" },
  { value: "OFFLINE", label: "Оффлайн" },
  { value: "REFERRAL", label: "Рекомендация" },
];

export function SourcesClient({ initial }: { initial: SourceRow[] }) {
  const [rows, setRows] = useState<SourceRow[]>(initial);
  /** Что было на экране при загрузке: удалять можно только это. */
  const [knownIds] = useState(() => initial.map((r) => r.id));
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(false);
  const [isPending, startTransition] = useTransition();

  const validationError = rows.some((s) => s.title.trim().length === 0)
    ? "У источника не может быть пустого названия"
    : null;

  function patch(id: string, next: Partial<SourceRow>) {
    setRows((ss) => ss.map((s) => (s.id === id ? { ...s, ...next } : s)));
    setSavedAt(false);
    setError(null);
  }
  function move(index: number, dir: -1 | 1) {
    setRows((ss) => {
      const next = [...ss];
      const target = index + dir;
      if (target < 0 || target >= next.length) return ss;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setSavedAt(false);
  }
  function addSource() {
    setRows((ss) => [
      ...ss,
      {
        id: `new-${Date.now()}`,
        code: "",
        title: "Новый источник",
        kind: "OFFLINE",
        isActive: true,
      },
    ]);
    setSavedAt(false);
  }
  function removeSource(id: string) {
    setRows((ss) => ss.filter((s) => s.id !== id));
    setSavedAt(false);
  }

  function save() {
    if (validationError) {
      setError(validationError);
      return;
    }
    startTransition(async () => {
      try {
        setRows(await saveSources(rows, knownIds));
        setSavedAt(true);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Не удалось сохранить");
      }
    });
  }

  return (
    <div className="flex max-w-[680px] flex-col gap-4">
      {error ? <p className="text-accent-text text-sm">{error}</p> : null}
      <Group>
        <ul className="flex flex-col gap-2">
          {rows.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2">
              <div className="flex flex-none flex-col">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label="Выше"
                  className="text-text-subtle hover:text-text text-xs leading-none disabled:opacity-30"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === rows.length - 1}
                  aria-label="Ниже"
                  className="text-text-subtle hover:text-text text-xs leading-none disabled:opacity-30"
                >
                  ▼
                </button>
              </div>
              <span className="num text-text-subtle w-5 flex-none text-center text-xs">{i + 1}</span>
              <TextInput
                value={s.title}
                onChange={(e) => patch(s.id, { title: e.target.value })}
                className="flex-1"
              />
              <select
                value={s.kind}
                onChange={(e) => patch(s.id, { kind: e.target.value as SourceRow["kind"] })}
                aria-label={`Тип источника ${s.title}`}
                className="border-border-input bg-surface flex-none rounded-md border px-2.5 py-2 text-sm outline-none"
              >
                {SOURCE_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <Toggle
                checked={s.isActive}
                onChange={(v) => patch(s.id, { isActive: v })}
                label={`${s.title} активен`}
              />
              <button
                type="button"
                onClick={() => removeSource(s.id)}
                aria-label={`Удалить ${s.title}`}
                className="text-text-subtle hover:text-text flex-none px-1 text-sm"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={addSource}
          className="border-border text-text-muted hover:bg-hover self-start rounded-md border px-3 py-1.5 text-sm"
        >
          + Добавить источник
        </button>
      </Group>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={isPending || Boolean(validationError)}
          className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isPending ? "Сохраняем…" : "Сохранить"}
        </button>
        {savedAt && !isPending ? <span className="text-text-muted text-sm">Сохранено</span> : null}
      </div>
    </div>
  );
}
