"use client";

import { useMemo, useState } from "react";
import { settingsStore, type KnowledgeItem } from "@/app/_data/settings";
import {
  Field,
  Group,
  SaveBar,
  Segmented,
  Textarea,
  TextInput,
  Toggle,
} from "../_components/ui";
import { saveSection } from "../blob-actions";
import { saveKnowledge } from "./actions";

type AssistantConfig = typeof settingsStore.assistant;

export interface AssistantData {
  assistant: AssistantConfig;
  knowledge: KnowledgeItem[];
}

function newKnowledgeItem(): KnowledgeItem {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `k${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return { id, topic: "", question: "", answer: "", serviceId: null, isActive: true };
}

export function AssistantClient({
  initial,
  serviceOptions,
}: {
  initial: AssistantData;
  serviceOptions: { id: string; title: string }[];
}) {
  const [assistant, setAssistant] = useState<AssistantConfig>(() =>
    structuredClone(initial.assistant),
  );
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>(() =>
    structuredClone(initial.knowledge),
  );
  const [query, setQuery] = useState("");
  const [stopDraft, setStopDraft] = useState("");
  const [dirtyKnowledgeIds, setDirtyKnowledgeIds] = useState<Set<string>>(() => new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return knowledge;
    return knowledge.filter(
      (k) =>
        k.topic.toLowerCase().includes(q) ||
        k.question.toLowerCase().includes(q) ||
        k.answer.toLowerCase().includes(q),
    );
  }, [knowledge, query]);

  const error = knowledge.some((k) => k.isActive && k.answer.trim().length === 0)
    ? "У активной записи базы знаний должен быть ответ"
    : null;

  function patchKnowledge(id: string, next: Partial<KnowledgeItem>) {
    setKnowledge((ks) => ks.map((k) => (k.id === id ? { ...k, ...next } : k)));
    setDirtyKnowledgeIds((ids) => new Set(ids).add(id));
  }

  return (
    <div className="flex max-w-[820px] flex-col gap-5">
      <Group title="Режим">
        <Field label="Работа ассистента">
          <Segmented
            value={assistant.mode}
            onChange={(v) => setAssistant({ ...assistant, mode: v })}
            options={[
              { value: "drafts", label: "Только черновики" },
              { value: "on", label: "Автономно" },
              { value: "off", label: "Выключен" },
            ]}
          />
        </Field>
        <Field label="Приветствие" htmlFor="a-greeting">
          <Textarea
            id="a-greeting"
            rows={2}
            value={assistant.greeting}
            onChange={(e) => setAssistant({ ...assistant, greeting: e.target.value })}
          />
        </Field>
        <Field label="Подпись" htmlFor="a-sign">
          <TextInput
            id="a-sign"
            value={assistant.signature}
            onChange={(e) => setAssistant({ ...assistant, signature: e.target.value })}
          />
        </Field>
      </Group>

      <Group title="Стоп-слова" hint="при них ассистент молчит и зовёт человека">
        <div className="flex flex-wrap gap-1.5">
          {assistant.stopWords.map((word) => (
            <span
              key={word}
              className="border-border bg-hover text-text-muted inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm"
            >
              {word}
              <button
                type="button"
                onClick={() =>
                  setAssistant({
                    ...assistant,
                    stopWords: assistant.stopWords.filter((w) => w !== word),
                  })
                }
                className="text-text-subtle hover:text-text"
                aria-label={`Убрать ${word}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const w = stopDraft.trim().toLowerCase();
            if (w && !assistant.stopWords.includes(w)) {
              setAssistant({ ...assistant, stopWords: [...assistant.stopWords, w] });
            }
            setStopDraft("");
          }}
        >
          <TextInput
            value={stopDraft}
            onChange={(e) => setStopDraft(e.target.value)}
            placeholder="Добавить стоп-слово"
            className="max-w-[240px]"
          />
          <button
            type="submit"
            className="border-border text-text-muted hover:bg-hover rounded-md border px-3 py-2 text-sm"
          >
            Добавить
          </button>
        </form>
      </Group>

      <Group title="База знаний" hint="ассистент отвечает только этими текстами">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по темам и ответам"
          className="border-border-input bg-surface placeholder:text-text-subtle w-full max-w-[320px] rounded-md border px-3 py-2 text-sm outline-none"
        />
        <ul className="flex flex-col gap-3">
          {filtered.length === 0 ? (
            <li className="text-text-subtle text-sm">Ничего не нашлось.</li>
          ) : (
            filtered.map((k) => (
              <li key={k.id} className="border-border-soft rounded-lg border p-3">
                <div className="flex items-center gap-3">
                  <TextInput
                    value={k.topic}
                    onChange={(e) => patchKnowledge(k.id, { topic: e.target.value })}
                    className="max-w-[220px] py-1.5 font-medium"
                  />
                  <select
                    value={k.serviceId ?? ""}
                    onChange={(e) => patchKnowledge(k.id, { serviceId: e.target.value || null })}
                    className="border-border-input bg-surface ml-auto rounded-md border px-2.5 py-1.5 text-sm outline-none"
                  >
                    <option value="">без услуги</option>
                    {serviceOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                  <div className="flex items-center gap-1.5">
                    <Toggle
                      checked={k.isActive}
                      onChange={(v) => patchKnowledge(k.id, { isActive: v })}
                      label={`${k.topic} активна`}
                    />
                  </div>
                </div>
                <TextInput
                  value={k.question}
                  onChange={(e) => patchKnowledge(k.id, { question: e.target.value })}
                  placeholder="Вопрос пациента"
                  className="mt-2 py-1.5"
                />
                <Textarea
                  value={k.answer}
                  onChange={(e) => patchKnowledge(k.id, { answer: e.target.value })}
                  placeholder="Ответ — дословно так, как отвечает ассистент"
                  rows={2}
                  className="mt-2"
                />
              </li>
            ))
          )}
        </ul>
        <button
          type="button"
          onClick={() => {
            const item = newKnowledgeItem();
            setKnowledge((items) => [
              ...items,
              // Новая запись сразу включена: выключенная по умолчанию — ловушка.
              // Администратор заполнял ответ, сохранял и не понимал, почему
              // ассистент про него не знает.
              item,
            ]);
            setDirtyKnowledgeIds((ids) => new Set(ids).add(item.id));
          }}
          className="border-border text-text-muted hover:bg-hover self-start rounded-md border px-3 py-1.5 text-sm"
        >
          + Добавить запись
        </button>
      </Group>

      <div className="flex items-center gap-3">
        <SaveBar
          error={error}
          onSave={async () => {
            // Конфигурацию и знания сохраняем в их настоящие места: поведение — в
            // настройку, тексты — в таблицу, которую читает агент.
            await saveSection("assistant", { assistant });
            if (dirtyKnowledgeIds.size > 0) {
              const changedKnowledge = knowledge.filter((item) => dirtyKnowledgeIds.has(item.id));
              setKnowledge(await saveKnowledge(changedKnowledge));
              setDirtyKnowledgeIds(new Set());
            }
          }}
        />
      </div>
    </div>
  );
}
