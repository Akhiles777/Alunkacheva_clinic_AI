"use client";

import { useState, useTransition } from "react";
import type { TemplateItem } from "@/app/_data/settings";
import { Group, SaveBar, Textarea, TextInput } from "../_components/ui";
import { saveSection } from "../blob-actions";

export interface TemplatesData {
  templates: TemplateItem[];
  quickReplies: string[];
}

const STATUS_LABEL: Record<TemplateItem["status"], { text: string; attention: boolean }> = {
  approved: { text: "согласован", attention: false },
  pending: { text: "на согласовании", attention: true },
  rejected: { text: "отклонён", attention: true },
  draft: { text: "черновик", attention: false },
};

const SAMPLE: Record<string, string> = { name: "Ирина", date: "24 июля", time: "18:30" };

function fillPreview(body: string): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => SAMPLE[key] ?? `{{${key}}}`);
}
function variables(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
}

export function TemplatesClient({ initial }: { initial: TemplatesData }) {
  const [templates, setTemplates] = useState<TemplateItem[]>(() =>
    structuredClone(initial.templates),
  );
  const [quickReplies, setQuickReplies] = useState<string[]>(() => [...initial.quickReplies]);
  const [isPending, startTransition] = useTransition();

  const error = templates.some((t) => t.body.trim().length === 0)
    ? "У шаблона не может быть пустого текста"
    : null;

  function patch(id: string, next: Partial<TemplateItem>) {
    setTemplates((ts) => ts.map((t) => (t.id === id ? { ...t, ...next } : t)));
  }

  return (
    <div className="flex max-w-[820px] flex-col gap-5">
      <Group title="Шаблоны WhatsApp" hint="переменные в двойных фигурных скобках, напр. {{name}}">
        <ul className="flex flex-col gap-3">
          {templates.map((t) => {
            const status = STATUS_LABEL[t.status];
            return (
              <li key={t.id} className="border-border-soft rounded-lg border p-3">
                <div className="flex items-center gap-3">
                  <TextInput
                    value={t.title}
                    onChange={(e) => patch(t.id, { title: e.target.value })}
                    className="max-w-[280px] py-1.5 font-medium"
                  />
                  <span className="num text-text-subtle text-xs">{t.code}</span>
                  <span
                    className={`ml-auto text-xs ${status.attention ? "text-accent-text font-medium" : "text-text-muted"}`}
                  >
                    {status.text}
                  </span>
                </div>
                <Textarea
                  value={t.body}
                  onChange={(e) => patch(t.id, { body: e.target.value })}
                  rows={2}
                  className="mt-2"
                />
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {variables(t.body).map((v) => (
                    <span key={v} className="num bg-hover text-text-muted rounded-sm px-1.5 py-0.5 text-2xs">
                      {`{{${v}}}`}
                    </span>
                  ))}
                  <span className="text-text-subtle text-xs">
                    превью: {fillPreview(t.body)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </Group>

      <Group title="Быстрые ответы" hint="для администратора, вставляются в поле ввода">
        <ul className="flex flex-col gap-2">
          {quickReplies.map((reply, i) => (
            <li key={i} className="flex items-center gap-2">
              <TextInput
                value={reply}
                onChange={(e) =>
                  setQuickReplies((qr) => qr.map((r, j) => (j === i ? e.target.value : r)))
                }
                className="flex-1"
              />
              <button
                type="button"
                onClick={() => setQuickReplies((qr) => qr.filter((_, j) => j !== i))}
                className="text-text-subtle hover:text-text px-1 text-sm"
                aria-label="Удалить быстрый ответ"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => setQuickReplies((qr) => [...qr, ""])}
          className="border-border text-text-muted hover:bg-hover self-start rounded-md border px-3 py-1.5 text-sm"
        >
          + Добавить ответ
        </button>
      </Group>

      <div className="flex items-center gap-3">
        <SaveBar
          error={error}
          onSave={() => {
            startTransition(async () => {
              await saveSection("templates", { templates, quickReplies });
            });
          }}
        />
        {isPending ? <span className="text-text-subtle text-sm">сохраняем…</span> : null}
      </div>
    </div>
  );
}
