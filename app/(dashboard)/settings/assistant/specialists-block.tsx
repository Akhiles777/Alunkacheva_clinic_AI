"use client";

import { useState, useTransition } from "react";
import { Group, TextInput } from "../_components/ui";
import { deleteSpecialist, saveSpecialist, type SpecialistItem } from "./specialists-actions";

/**
 * Кому ассистент задаёт вопросы, на которые не отвечает сам.
 *
 * Здесь было три переключателя — «медицинские», «деловые», «пересылать», — и
 * заказчик справедливо спросил, зачем заполнять то, что уже есть: кто какие
 * услуги ведёт, записано в визитах, а кто в клинике главный — в справочнике
 * сотрудников. Осталось то, чего в базе нет: номер WhatsApp.
 *
 * Кому уйдёт вопрос, решает дело: про БОС-терапию — тому, кто её ведёт, а не
 * остеопату. Деловой вопрос — первому в списке.
 */
export function SpecialistsBlock({
  initial,
  staffOptions,
}: {
  initial: SpecialistItem[];
  staffOptions: { id: string; name: string; specialty: string }[];
}) {
  const [rows, setRows] = useState<SpecialistItem[]>(initial);
  const [draft, setDraft] = useState<{ id?: string; staffId: string; phone: string }>({
    staffId: "",
    phone: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const free = staffOptions.filter(
    (s) => draft.staffId === s.id || !rows.some((r) => r.staffId === s.id && r.id !== draft.id),
  );

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await saveSpecialist(draft);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setRows((list) =>
        list.some((r) => r.id === res.row.id)
          ? list.map((r) => (r.id === res.row.id ? { ...res.row, asked: r.asked, answered: r.answered } : r))
          : [...list, res.row],
      );
      setDraft({ staffId: "", phone: "" });
    });
  }

  return (
    <Group title="Кому пересылать вопросы" hint="сотрудник из справочника и его WhatsApp">
      <p className="text-text-muted text-xs">
        Ассистент пересылает только то, на что у него нет ответа и что не решается справкой:
        сложный вопрос о здоровье, претензию, предложение о работе или рекламе. Мелкие уточнения
        он по-прежнему передаёт администратору. Вопрос уходит тому, кто ведёт названную услугу;
        деловой — первому в списке. Ответ специалиста ассистент пересказывает пациенту, а фраза
        «не отправляй, я сама» ответом не считается.
      </p>

      {rows.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {rows.map((r) => {
            const staff = staffOptions.find((s) => s.id === r.staffId);
            return (
              <li
                key={r.id}
                className="border-border-soft flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2"
              >
                <span className="font-medium">{r.name}</span>
                <span className="num text-text-muted text-sm">{r.phone}</span>
                {staff?.specialty ? (
                  <span className="text-text-subtle text-2xs">{staff.specialty}</span>
                ) : null}
                {r.staffId ? null : (
                  <span className="text-accent-text text-2xs">нет в справочнике сотрудников</span>
                )}
                <span className="text-text-subtle ml-auto text-2xs">
                  вопросов {r.asked}, ответов {r.answered}
                </span>
                <button
                  type="button"
                  onClick={() => setDraft({ id: r.id, staffId: r.staffId ?? "", phone: r.phone })}
                  className="border-border text-text-muted hover:bg-hover rounded-md border px-2 py-1 text-xs"
                >
                  Изменить
                </button>
                <button
                  type="button"
                  onClick={() =>
                    startTransition(async () => {
                      await deleteSpecialist(r.id);
                      setRows((list) => list.filter((x) => x.id !== r.id));
                    })
                  }
                  className="text-text-subtle hover:text-danger-text px-1 text-xs"
                >
                  Удалить
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-text-subtle mt-3 text-sm">
          Пока никого нет — вопросы уходят только администратору, как раньше.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          value={draft.staffId}
          onChange={(e) => setDraft({ ...draft, staffId: e.target.value })}
          className="border-border-input bg-surface min-w-[240px] rounded-md border px-2 py-2 text-sm"
        >
          <option value="">Кто отвечает…</option>
          {free.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.specialty ? ` — ${s.specialty}` : ""}
            </option>
          ))}
        </select>
        <TextInput
          value={draft.phone}
          onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
          placeholder="+7 929 874-17-78"
          className="max-w-[200px]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={isPending || !draft.staffId}
          className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
        >
          {draft.id ? "Сохранить" : "Добавить"}
        </button>
        {draft.id ? (
          <button
            type="button"
            onClick={() => setDraft({ staffId: "", phone: "" })}
            className="text-text-muted hover:text-text text-sm"
          >
            Отмена
          </button>
        ) : null}
      </div>
      {staffOptions.length === 0 ? (
        <p className="text-text-subtle mt-2 text-2xs">
          В справочнике нет активных сотрудников — сначала заведите их в «Настройки → Сотрудники».
        </p>
      ) : null}
      {error ? <p className="text-danger-text mt-2 text-sm">{error}</p> : null}
    </Group>
  );
}
