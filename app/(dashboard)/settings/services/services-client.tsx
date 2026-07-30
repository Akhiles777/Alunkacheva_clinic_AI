"use client";

import { useState, useTransition } from "react";
import { Field, Group, Toggle } from "../_components/ui";
import { saveServices, type ServiceRow, type ServicesPayload } from "./actions";

const KIND_OPTIONS: { value: ServiceRow["kind"]; label: string }[] = [
  { value: "OSTEOPATHY", label: "Остеопатия" },
  { value: "IV_THERAPY", label: "IV-терапия" },
  { value: "BIOFEEDBACK", label: "БОС-терапия" },
  { value: "NEUROMEDITATION", label: "Нейромедитация" },
  { value: "LAB", label: "Анализы" },
  { value: "OTHER", label: "Другое" },
];

function blankService(): ServiceRow {
  return {
    id: `new-${Date.now()}`,
    title: "Новая услуга",
    kind: "OTHER",
    price: 0,
    durationMin: 30,
    isActive: true,
    isCourse: false,
    defaultSessions: null,
    stalledAfterDays: null,
    roomIds: [],
  };
}

export function ServicesClient({ initial }: { initial: ServicesPayload }) {
  const [services, setServices] = useState<ServiceRow[]>(initial.services);
  const { roomOptions } = initial;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function patch(id: string, next: Partial<ServiceRow>) {
    setServices((ss) => ss.map((s) => (s.id === id ? { ...s, ...next } : s)));
    setSaved(false);
    setError(null);
  }
  function toggleRoom(id: string, roomId: string) {
    setServices((ss) =>
      ss.map((s) =>
        s.id === id
          ? {
              ...s,
              roomIds: s.roomIds.includes(roomId)
                ? s.roomIds.filter((r) => r !== roomId)
                : [...s.roomIds, roomId],
            }
          : s,
      ),
    );
    setSaved(false);
  }
  function addService() {
    setServices((ss) => [...ss, blankService()]);
    setSaved(false);
  }
  function removeService(id: string) {
    setServices((ss) => ss.filter((s) => s.id !== id));
    setSaved(false);
  }

  function save() {
    startTransition(async () => {
      try {
        const res = await saveServices(services);
        setServices(res.services);
        setSaved(true);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Не удалось сохранить");
      }
    });
  }

  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="num text-text-subtle text-xs">{services.length} услуг</span>
        <button
          type="button"
          onClick={addService}
          className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3.5 py-2 text-sm font-medium"
        >
          + Услуга
        </button>
      </div>

      {error ? <p className="text-accent-text text-sm">{error}</p> : null}

      {services.map((s) => (
        <Group key={s.id}>
          <Field label="Название" htmlFor={`${s.id}-title`}>
            <input
              id={`${s.id}-title`}
              value={s.title}
              onChange={(e) => patch(s.id, { title: e.target.value })}
              className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
            />
          </Field>
          <Field label="Направление" htmlFor={`${s.id}-kind`}>
            <select
              id={`${s.id}-kind`}
              value={s.kind}
              onChange={(e) => patch(s.id, { kind: e.target.value as ServiceRow["kind"] })}
              className="border-border-input bg-surface rounded-md border px-2.5 py-2 text-sm outline-none"
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[200px_minmax(0,1fr)] md:items-start">
            <span className="text-sm">Параметры</span>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="flex items-center gap-1.5 text-sm">
                <span className="text-text-subtle text-2xs">длит.</span>
                <input
                  type="number"
                  min={5}
                  step={5}
                  value={s.durationMin}
                  onChange={(e) => patch(s.id, { durationMin: Number(e.target.value) })}
                  className="border-border-input bg-surface num w-16 rounded-md border px-2 py-1.5 text-sm outline-none"
                />
                <span className="text-text-subtle text-2xs">мин</span>
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <span className="text-text-subtle text-2xs">цена</span>
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={s.price}
                  onChange={(e) => patch(s.id, { price: Number(e.target.value) })}
                  className="border-border-input bg-surface num w-24 rounded-md border px-2 py-1.5 text-sm outline-none"
                />
                <span className="text-text-subtle text-2xs">₽</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Toggle checked={s.isActive} onChange={(v) => patch(s.id, { isActive: v })} />
                активна
              </label>
            </div>
          </div>

          <Field label="Продаётся курсом">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Toggle
                checked={s.isCourse}
                onChange={(v) =>
                  patch(s.id, {
                    isCourse: v,
                    defaultSessions: v ? (s.defaultSessions ?? 10) : null,
                    stalledAfterDays: v ? (s.stalledAfterDays ?? 10) : null,
                  })
                }
              />
              {s.isCourse ? (
                <>
                  <label className="flex items-center gap-1.5 text-sm">
                    <span className="text-text-subtle text-2xs">сеансов</span>
                    <input
                      type="number"
                      min={1}
                      value={s.defaultSessions ?? 0}
                      onChange={(e) => patch(s.id, { defaultSessions: Number(e.target.value) })}
                      className="border-border-input bg-surface num w-16 rounded-md border px-2 py-1.5 text-sm outline-none"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-sm">
                    <span className="text-text-subtle text-2xs">выпадение через</span>
                    <input
                      type="number"
                      min={1}
                      value={s.stalledAfterDays ?? 0}
                      onChange={(e) => patch(s.id, { stalledAfterDays: Number(e.target.value) })}
                      className="border-border-input bg-surface num w-16 rounded-md border px-2 py-1.5 text-sm outline-none"
                    />
                    <span className="text-text-subtle text-2xs">дн</span>
                  </label>
                </>
              ) : (
                <span className="text-text-subtle text-sm">разовая услуга</span>
              )}
            </div>
          </Field>

          <Field label="Кабинеты" hint="где услуга может проводиться — знаменатель загрузки">
            {roomOptions.length === 0 ? (
              <p className="text-text-subtle text-sm">Сначала добавьте кабинеты.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {roomOptions.map((room) => {
                  const on = s.roomIds.includes(room.id);
                  return (
                    <button
                      key={room.id}
                      type="button"
                      onClick={() => toggleRoom(s.id, room.id)}
                      className={`rounded-md border px-2.5 py-1.5 text-sm ${
                        on
                          ? "border-accent-border bg-accent-tint text-accent-text font-medium"
                          : "border-border text-text-muted hover:bg-hover"
                      }`}
                    >
                      {room.label}
                    </button>
                  );
                })}
              </div>
            )}
          </Field>

          <div className="border-border-soft flex justify-end border-t pt-3">
            <button
              type="button"
              onClick={() => removeService(s.id)}
              className="text-text-subtle hover:text-text text-sm"
            >
              Удалить услугу
            </button>
          </div>
        </Group>
      ))}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isPending ? "Сохраняем…" : "Сохранить"}
        </button>
        {saved && !isPending ? <span className="text-text-muted text-sm">Сохранено</span> : null}
      </div>
    </div>
  );
}
