"use client";

import { useState, useTransition } from "react";
import { Group, SaveBar, Textarea, TextInput } from "../_components/ui";
import { saveSection } from "../blob-actions";
import { deleteTemplate, saveTemplate } from "./actions";
import type { TemplateRow } from "@/lib/server/message-templates";
import { VARIABLE_LABEL, fillTemplate } from "@/lib/message-template";

export interface TemplatesData {
  templates: TemplateRow[];
  quickReplies: string[];
}

type Status = TemplateRow["status"];

const STATUS_LABEL: Record<Status, { text: string; attention: boolean }> = {
  approved: { text: "согласован", attention: false },
  pending: { text: "на согласовании", attention: true },
  rejected: { text: "отклонён", attention: true },
  draft: { text: "черновик", attention: false },
};

const STATUS_ORDER: Status[] = ["draft", "pending", "approved", "rejected"];

/** Пример подстановки: администратор должен видеть, что придёт пациенту. */
const SAMPLE: Record<string, string> = {
  name: "Гульбара",
  date: "8 сентября",
  time: "09:00",
  service: "Детский приём — остеопатия",
  staff: "Ирина Алилгаджиевна",
  clinic: "Алункачева клиник",
};

function preview(body: string): string {
  const filled = fillTemplate(body, SAMPLE);
  return filled.ok ? filled.text : body;
}

/**
 * Шаблоны WhatsApp.
 *
 * Раздел был декорацией: добавить или удалить шаблон было нельзя, статус не
 * менялся, а переменные никто не подставлял — кнопка в инбоксе отправляла
 * пациенту «Здравствуйте, {{name}}!». Теперь шаблоны живут в той же таблице,
 * из которой их берёт инбокс, а подстановка идёт на сервере.
 */
export function TemplatesClient({ initial }: { initial: TemplatesData }) {
  const [rows, setRows] = useState<TemplateRow[]>(initial.templates);
  const [quickReplies, setQuickReplies] = useState<string[]>(() => [...initial.quickReplies]);
  const [draft, setDraft] = useState<{ id?: string; title: string; body: string; status: Status }>({
    title: "",
    body: "",
    status: "draft",
  });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await saveTemplate(draft);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setRows((list) =>
        list.some((r) => r.id === res.row.id)
          ? list.map((r) => (r.id === res.row.id ? res.row : r))
          : [...list, res.row],
      );
      setDraft({ title: "", body: "", status: "draft" });
    });
  }

  return (
    <div className="flex max-w-[820px] flex-col gap-5">
      <Group
        title="Шаблоны WhatsApp"
        hint="переменные в двойных фигурных скобках — подставляются при отправке"
      >
        <p className="text-text-muted text-xs">
          Доступны: {Object.entries(VARIABLE_LABEL).map(([k, v]) => `{{${k}}} — ${v}`).join("; ")}.
          Если данных для переменной нет, шаблон не отправится, а администратор увидит, чего не
          хватает: сообщение с дырой хуже неотправленного.
        </p>

        {rows.length === 0 ? (
          <p className="text-text-subtle mt-3 text-sm">Шаблонов пока нет.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {rows.map((t) => {
              const status = STATUS_LABEL[t.status];
              return (
                <li key={t.id} className="border-border-soft rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-medium">{t.title}</span>
                    <span className="num text-text-subtle text-xs">{t.code}</span>
                    <span
                      className={`text-xs ${status.attention ? "text-accent-text font-medium" : "text-text-muted"}`}
                    >
                      {status.text}
                    </span>
                    <button
                      type="button"
                      onClick={() => setDraft({ id: t.id, title: t.title, body: t.body, status: t.status })}
                      className="border-border text-text-muted hover:bg-hover ml-auto rounded-md border px-2 py-1 text-xs"
                    >
                      Изменить
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        startTransition(async () => {
                          await deleteTemplate(t.id);
                          setRows((list) => list.filter((r) => r.id !== t.id));
                        })
                      }
                      className="text-text-subtle hover:text-danger-text px-1 text-xs"
                    >
                      Удалить
                    </button>
                  </div>
                  <p className="text-text-muted mt-1.5 text-sm">{t.body}</p>
                  {t.variables.length > 0 ? (
                    <p className="text-text-subtle mt-1 text-2xs">пациент увидит: {preview(t.body)}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <div className="border-border-soft mt-4 flex flex-col gap-3 rounded-lg border p-3">
          <TextInput
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="Название — его видит администратор на кнопке"
          />
          <Textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            rows={2}
            placeholder="Здравствуйте, {{name}}! Напоминаем о визите {{date}} в {{time}}."
          />
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value as Status })}
              className="border-border-input bg-surface rounded-md border px-2 py-1.5 text-sm"
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s].text}
                </option>
              ))}
            </select>
            <span className="text-text-subtle text-2xs">
              вне 24-часового окна отправляются только согласованные
            </span>
            <button
              type="button"
              onClick={submit}
              disabled={isPending}
              className="bg-accent text-accent-contrast hover:bg-accent-hover ml-auto rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
            >
              {draft.id ? "Сохранить" : "Добавить шаблон"}
            </button>
            {draft.id ? (
              <button
                type="button"
                onClick={() => setDraft({ title: "", body: "", status: "draft" })}
                className="text-text-muted hover:text-text text-sm"
              >
                Отмена
              </button>
            ) : null}
          </div>
          {error ? <p className="text-danger-text text-sm">{error}</p> : null}
        </div>
      </Group>

      <Group title="Быстрые ответы" hint="для администратора, вставляются в поле ввода">
        <ul className="flex flex-col gap-2">
          {quickReplies.map((reply, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
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
                className="text-text-subtle hover:text-text flex h-9 w-9 items-center justify-center text-sm"
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
        <SaveBar
          onSave={() => {
            startTransition(async () => {
              await saveSection("templates", { quickReplies });
            });
          }}
        />
      </Group>
    </div>
  );
}
