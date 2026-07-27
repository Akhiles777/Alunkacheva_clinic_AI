"use client";

import { useMemo, useState } from "react";
import { settingsStore, type KnowledgeItem } from "@/app/_data/settings";
import {
  Field,
  Group,
  SaveBar,
  Segmented,
  SettingsHeader,
  Textarea,
  TextInput,
  Toggle,
} from "../_components/ui";

const SERVICE_OPTIONS = settingsStore.services.map((s) => ({ id: s.id, title: s.title }));

export default function AssistantSettingsPage() {
  const [assistant, setAssistant] = useState(() => structuredClone(settingsStore.assistant));
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>(() =>
    structuredClone(settingsStore.knowledge),
  );
  const [query, setQuery] = useState("");
  const [stopDraft, setStopDraft] = useState("");

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
  }

  return (
    <>
      <SettingsHeader
        title="Ассистент"
        description="Ассистент отвечает только текстами из базы знаний и не сочиняет. По умолчанию — только черновики: администратор отправляет. При стоп-словах молчит и зовёт человека."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
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
                        {SERVICE_OPTIONS.map((s) => (
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
              onClick={() =>
                setKnowledge([
                  ...knowledge,
                  { id: `k${Date.now()}`, topic: "Новая тема", question: "", answer: "", serviceId: null, isActive: false },
                ])
              }
              className="border-border text-text-muted hover:bg-hover self-start rounded-md border px-3 py-1.5 text-sm"
            >
              + Добавить запись
            </button>
          </Group>

          <SaveBar
            error={error}
            onSave={() => {
              settingsStore.assistant = structuredClone(assistant);
              settingsStore.knowledge = structuredClone(knowledge);
            }}
          />
        </div>
      </div>
    </>
  );
}
