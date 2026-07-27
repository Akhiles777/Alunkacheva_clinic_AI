"use client";

import { useState } from "react";
import { settingsStore, type SourceSettings } from "@/app/_data/settings";
import { Group, SaveBar, SettingsHeader, TextInput, Toggle } from "../_components/ui";

export default function SourcesSettingsPage() {
  const [sources, setSources] = useState<SourceSettings[]>(() =>
    structuredClone(settingsStore.sources).sort((a, b) => a.sortOrder - b.sortOrder),
  );

  const error = sources.some((s) => s.title.trim().length === 0)
    ? "У источника не может быть пустого названия"
    : null;

  function patch(id: string, next: Partial<SourceSettings>) {
    setSources((ss) => ss.map((s) => (s.id === id ? { ...s, ...next } : s)));
  }
  function move(index: number, dir: -1 | 1) {
    setSources((ss) => {
      const next = [...ss];
      const target = index + dir;
      if (target < 0 || target >= next.length) return ss;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  function addSource() {
    setSources((ss) => [
      ...ss,
      {
        id: `src-${Date.now()}`,
        code: `custom_${ss.length + 1}`,
        title: "Новый источник",
        isActive: true,
        sortOrder: ss.length,
      },
    ]);
  }

  return (
    <>
      <SettingsHeader
        title="Источники"
        description="Справочник источников обращений. Порядок — как в форме занесения звонка: самые частые сверху. Можно добавлять свои."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[640px] flex-col gap-4">
          <Group>
            <ul className="flex flex-col gap-1.5">
              {sources.map((s, i) => (
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
                      disabled={i === sources.length - 1}
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
                  <span className="num text-text-subtle w-24 flex-none truncate text-xs">{s.code}</span>
                  <Toggle
                    checked={s.isActive}
                    onChange={(v) => patch(s.id, { isActive: v })}
                    label={`${s.title} активен`}
                  />
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

          <SaveBar
            error={error}
            onSave={() => {
              settingsStore.sources = sources.map((s, i) => ({ ...s, sortOrder: i * 10 }));
            }}
          />
        </div>
      </div>
    </>
  );
}
