"use client";

import { useState, useTransition } from "react";
import { Group, TextInput, Toggle } from "../_components/ui";
import {
  deleteSpecialist,
  saveSpecialist,
  type SpecialistItem,
} from "./specialists-actions";

/**
 * Кому ассистент задаёт вопросы, на которые не отвечает сам.
 *
 * Раздел маленький намеренно: это не «сотрудники клиники», а короткий список
 * тех, кому бот пишет в WhatsApp. Ошибиться здесь дорого — неверный номер
 * означает, что вопрос уйдёт постороннему человеку, — поэтому номер проверяется
 * на сервере и приводится к единому виду.
 */

const EMPTY = {
  name: "",
  phone: "",
  role: "",
  isDoctor: true,
  isManager: false,
  isActive: true,
};

export function SpecialistsBlock({ initial }: { initial: SpecialistItem[] }) {
  const [rows, setRows] = useState<SpecialistItem[]>(initial);
  const [draft, setDraft] = useState<typeof EMPTY & { id?: string }>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function reload(next: SpecialistItem[]) {
    setRows(next);
    setDraft(EMPTY);
    setError(null);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await saveSpecialist(draft);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const saved: SpecialistItem = {
        id: res.id,
        name: draft.name.trim(),
        phone: draft.phone.trim(),
        role: draft.role.trim(),
        isDoctor: draft.isDoctor,
        isManager: draft.isManager,
        isActive: draft.isActive,
        asked: rows.find((r) => r.id === res.id)?.asked ?? 0,
        answered: rows.find((r) => r.id === res.id)?.answered ?? 0,
      };
      reload(
        rows.some((r) => r.id === res.id)
          ? rows.map((r) => (r.id === res.id ? saved : r))
          : [...rows, saved],
      );
    });
  }

  return (
    <Group
      title="Кому пересылать вопросы"
      hint="медицинские — врачу, деловые (работа, реклама, претензии) — руководству"
    >
      <p className="text-text-muted text-xs">
        Ассистент пересылает только то, на что у него нет ответа: если в базе знаний ответ есть,
        он отвечает сам и никого не беспокоит. Ответ специалиста он пересказывает пациенту в
        переписке. Фраза «не отправляй, я сама» ответом не считается — пациенту она не уходит.
      </p>

      {rows.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="border-border-soft flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2"
            >
              <span className="font-medium">{r.name}</span>
              <span className="num text-text-muted text-sm">{r.phone}</span>
              <span className="text-text-subtle text-2xs">
                {[r.isDoctor ? "медицинские" : null, r.isManager ? "деловые" : null]
                  .filter(Boolean)
                  .join(" · ")}
                {r.role ? ` · ${r.role}` : ""}
                {r.isActive ? "" : " · выключен"}
              </span>
              <span className="text-text-subtle ml-auto text-2xs">
                вопросов {r.asked}, ответов {r.answered}
              </span>
              <button
                type="button"
                onClick={() => setDraft({ ...r, role: r.role ?? "" })}
                className="border-border text-text-muted hover:bg-hover rounded-md border px-2 py-1 text-xs"
              >
                Изменить
              </button>
              <button
                type="button"
                onClick={() =>
                  startTransition(async () => {
                    await deleteSpecialist(r.id);
                    reload(rows.filter((x) => x.id !== r.id));
                  })
                }
                className="text-text-subtle hover:text-danger-text px-1 text-xs"
              >
                Удалить
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-text-subtle mt-3 text-sm">
          Пока никого нет — вопросы уходят только администратору, как раньше.
        </p>
      )}

      <div className="border-border-soft mt-4 flex flex-col gap-3 rounded-lg border p-3">
        <div className="flex flex-wrap gap-3">
          <TextInput
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Имя и отчество — как обратиться"
            className="max-w-[280px]"
          />
          <TextInput
            value={draft.phone}
            onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
            placeholder="+7 929 874-17-78"
            className="max-w-[200px]"
          />
          <TextInput
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
            placeholder="кто это в клинике"
            className="max-w-[220px]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Toggle
            checked={draft.isDoctor}
            onChange={(v) => setDraft({ ...draft, isDoctor: v })}
            label="Медицинские вопросы"
          />
          <Toggle
            checked={draft.isManager}
            onChange={(v) => setDraft({ ...draft, isManager: v })}
            label="Деловые вопросы и претензии"
          />
          <Toggle
            checked={draft.isActive}
            onChange={(v) => setDraft({ ...draft, isActive: v })}
            label="Пересылать"
          />
          <button
            type="button"
            onClick={submit}
            disabled={isPending}
            className="bg-accent text-accent-contrast hover:bg-accent-hover ml-auto rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
          >
            {draft.id ? "Сохранить" : "Добавить"}
          </button>
          {draft.id ? (
            <button
              type="button"
              onClick={() => reload(rows)}
              className="text-text-muted hover:text-text text-sm"
            >
              Отмена
            </button>
          ) : null}
        </div>
        {error ? <p className="text-danger-text text-sm">{error}</p> : null}
      </div>
    </Group>
  );
}
