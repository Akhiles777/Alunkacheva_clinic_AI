"use client";

import { useState } from "react";
import { settingsStore, type ServiceSettings } from "@/app/_data/settings";
import { Field, Group, SaveBar, SettingsHeader, TextInput, Toggle } from "../_components/ui";

const ROOM_OPTIONS = settingsStore.rooms.map((r) => ({
  id: r.id,
  label: r.name.replace(/ —.*/, ""),
}));

export default function ServicesSettingsPage() {
  const [services, setServices] = useState<ServiceSettings[]>(() =>
    structuredClone(settingsStore.services),
  );

  const badCourse = services.find(
    (s) => s.isCourse && (!s.defaultSessions || s.defaultSessions < 1),
  );
  const noRoom = services.find((s) => s.roomIds.length === 0);
  const error = badCourse
    ? `«${badCourse.title}»: у курсовой услуги укажите размер курса`
    : noRoom
      ? `«${noRoom.title}»: выберите хотя бы один кабинет`
      : null;

  function patch(id: string, next: Partial<ServiceSettings>) {
    setServices((ss) => ss.map((s) => (s.id === id ? { ...s, ...next } : s)));
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
  }

  return (
    <>
      <SettingsHeader
        title="Услуги"
        description="Название, направление, длительность, цена, активность. Флаг «продаётся курсом» с размером курса и порогом выпадения из графика. Кабинеты, где услуга проводится, — знаменатель загрузки по услугам."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[760px] flex-col gap-4">
          {services.map((s) => (
            <Group key={s.id}>
              <Field label="Название" htmlFor={`${s.id}-title`}>
                <TextInput
                  id={`${s.id}-title`}
                  value={s.title}
                  onChange={(e) => patch(s.id, { title: e.target.value })}
                />
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

              <Field label="Кабинеты" hint="где услуга может проводиться">
                <div className="flex flex-wrap gap-1.5">
                  {ROOM_OPTIONS.map((room) => {
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
              </Field>
            </Group>
          ))}

          <SaveBar
            error={error}
            onSave={() => {
              settingsStore.services = structuredClone(services);
            }}
          />
        </div>
      </div>
    </>
  );
}
