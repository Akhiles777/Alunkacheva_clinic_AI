"use client";

import { useMemo, useState } from "react";
import { settingsStore, type KnowledgeItem } from "@/app/_data/settings";
import {
  Field,
  Group,
  Modal,
  SaveBar,
  Segmented,
  Textarea,
  TextInput,
  Toggle,
} from "../_components/ui";
import { saveSection } from "../blob-actions";
import { deleteKnowledge, saveKnowledge } from "./actions";

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
  const [persistedKnowledgeIds, setPersistedKnowledgeIds] = useState<Set<string>>(
    () => new Set(initial.knowledge.map((item) => item.id)),
  );
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  function removeDraft(id: string) {
    setKnowledge((ks) => ks.filter((k) => k.id !== id));
    setDirtyKnowledgeIds((ids) => {
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
  }

  async function confirmDeleteKnowledge() {
    if (!deleteTarget) return;
    setDeleteError(null);
    if (!persistedKnowledgeIds.has(deleteTarget.id)) {
      removeDraft(deleteTarget.id);
      setDeleteTarget(null);
      return;
    }

    setIsDeleting(true);
    try {
      const nextKnowledge = await deleteKnowledge(deleteTarget.id);
      setKnowledge(nextKnowledge);
      setPersistedKnowledgeIds(new Set(nextKnowledge.map((item) => item.id)));
      setDirtyKnowledgeIds((ids) => {
        const next = new Set(ids);
        next.delete(deleteTarget.id);
        return next;
      });
      setDeleteTarget(null);
    } catch (e) {
      console.error(e);
      setDeleteError("Не удалось удалить запись. Обновите страницу и попробуйте ещё раз.");
    } finally {
      setIsDeleting(false);
    }
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
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteTarget(k);
                        setDeleteError(null);
                      }}
                      aria-label={`Удалить запись ${k.topic || "без темы"}`}
                      className="text-text-subtle hover:text-accent-text flex h-9 w-9 items-center justify-center text-sm"
                    >
                      ×
                    </button>
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
            setQuery("");
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
              const nextKnowledge = await saveKnowledge(changedKnowledge);
              setKnowledge(nextKnowledge);
              setPersistedKnowledgeIds(new Set(nextKnowledge.map((item) => item.id)));
              setDirtyKnowledgeIds(new Set());
            }
          }}
        />
      </div>

      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => {
          if (!isDeleting) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        title="Удалить запись"
        description="Запись будет безвозвратно удалена из базы знаний и больше не будет доступна ассистенту."
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setDeleteTarget(null);
                setDeleteError(null);
              }}
              disabled={isDeleting}
              className="border-border text-text-muted hover:bg-hover rounded-md border px-3.5 py-2 text-sm disabled:opacity-45"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={confirmDeleteKnowledge}
              disabled={isDeleting}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3.5 py-2 text-sm font-medium disabled:opacity-45"
            >
              {isDeleting ? "Удаляем…" : "Удалить"}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-text-muted text-sm leading-relaxed">
            {deleteTarget?.topic ? `Тема: ${deleteTarget.topic}` : "Эта запись ещё без темы."}
          </p>
          {deleteError ? <p className="text-accent-text text-sm">{deleteError}</p> : null}
        </div>
      </Modal>
    </div>
  );
}
