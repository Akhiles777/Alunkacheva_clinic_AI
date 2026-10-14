"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PromoDetail } from "@/lib/server/promos";
import { Group, TextInput, Textarea, Toggle } from "../settings/_components/ui";
import { approvePromoKnowledge, savePromoKnowledge, setPromoKnowledgeActive } from "./actions";

type Entry = PromoDetail["knowledge"][number];

/**
 * Что агент знает об акции. Ровно эти тексты он отвечает пациенту — дословно,
 * и только пока акция идёт, у неё стоит «агент знает» и пациент сам спросил.
 * В промпт агента текст акции не зашит: нет записи — агент об акции молчит.
 */
export function PromoKnowledge({
  promoId,
  entries,
  canEdit,
  canApprove,
}: {
  promoId: string;
  entries: Entry[];
  canEdit: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Partial<Entry> & { medical?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      router.refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не получилось");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Group
      title="Что агент знает об акции"
      hint="Агент отвечает этими текстами дословно и только тому, кто сам спросил об акции. Нет записи — агент об акции молчит."
    >
      {entries.length === 0 ? (
        <p className="text-text-muted text-sm">
          Записей нет — агент об акции не знает, даже если переключатель «агент знает» включён.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {entries.map((e) => (
            <li key={e.id} className="border-border-soft rounded-md border px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-medium">{e.topic}</span>
                <span className="text-text-subtle text-2xs">
                  {e.needsDoctorApproval
                    ? e.approvedAt
                      ? "медицинская · утверждена"
                      : "медицинская · ждёт утверждения врачом"
                    : "справочная"}
                  {e.isActive ? " · агент видит" : " · выключена"}
                </span>
                {canEdit ? (
                  <span className="ml-auto flex items-center gap-3">
                    <Toggle
                      checked={e.isActive}
                      label={`Запись «${e.topic}» включена`}
                      onChange={(v) => void run(() => setPromoKnowledgeActive(e.id, v))}
                    />
                    <button type="button" className="text-text-muted hover:text-text text-xs" onClick={() => setEditing(e)}>
                      Править
                    </button>
                  </span>
                ) : null}
              </div>
              <p className="text-text-muted mt-1 text-xs">Вопрос: {e.question}</p>
              <p className="mt-1 text-sm leading-relaxed whitespace-pre-line">{e.answer}</p>
              {e.needsDoctorApproval && !e.approvedAt && canApprove ? (
                <button
                  type="button"
                  disabled={busy}
                  className="border-border hover:bg-hover mt-2 rounded-md border px-2.5 py-1 text-xs"
                  onClick={() => void run(() => approvePromoKnowledge(e.id))}
                >
                  Утвердить текст как врач
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit && !editing ? (
        <button
          type="button"
          className="text-accent-text self-start text-sm hover:underline"
          onClick={() => setEditing({ topic: "", question: "", answer: "", medical: false })}
        >
          + Добавить запись
        </button>
      ) : null}

      {editing ? (
        <form
          className="border-border-soft flex flex-col gap-2 border-t pt-4"
          onSubmit={async (ev) => {
            ev.preventDefault();
            const ok = await run(() =>
              savePromoKnowledge({
                promoId,
                id: editing.id,
                topic: editing.topic ?? "",
                question: editing.question ?? "",
                answer: editing.answer ?? "",
                medical: Boolean(editing.medical),
              }),
            );
            if (ok) setEditing(null);
          }}
        >
          <TextInput
            aria-label="Тема"
            placeholder="Тема — например, «Что входит в check-up»"
            value={editing.topic ?? ""}
            onChange={(e) => setEditing({ ...editing, topic: e.target.value })}
          />
          <TextInput
            aria-label="Вопрос"
            placeholder="Как спрашивают — «что за школьный чек-ап, сколько стоит»"
            value={editing.question ?? ""}
            onChange={(e) => setEditing({ ...editing, question: e.target.value })}
          />
          <Textarea
            aria-label="Ответ"
            rows={4}
            placeholder="Что агент ответит пациенту — дословно"
            value={editing.answer ?? ""}
            onChange={(e) => setEditing({ ...editing, answer: e.target.value })}
          />
          {!editing.id ? (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={Boolean(editing.medical)}
                onChange={(e) => setEditing({ ...editing, medical: e.target.checked })}
              />
              Медицинская тема (противопоказания, подготовка) — включится после утверждения врачом
            </label>
          ) : editing.needsDoctorApproval ? (
            <p className="text-text-subtle text-xs">Правка медицинской записи снимает утверждение врача и выключает её.</p>
          ) : null}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-45"
            >
              Сохранить
            </button>
            <button type="button" className="text-text-muted hover:text-text text-sm" onClick={() => setEditing(null)}>
              Отмена
            </button>
          </div>
        </form>
      ) : null}
      {error ? <p className="text-accent-text text-sm">{error}</p> : null}
    </Group>
  );
}
