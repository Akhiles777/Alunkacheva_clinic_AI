"use client";

import { useState } from "react";
import { settingsStore, WEEKDAYS, type ClinicSettings } from "@/app/_data/settings";
import { Field, Group, SaveBar, SettingsHeader, TextInput, TimeInput, Toggle } from "../_components/ui";

const TIMEZONES = ["Europe/Moscow", "Europe/Kaliningrad", "Asia/Yekaterinburg", "Asia/Novosibirsk"];

export default function ClinicSettingsPage() {
  const [form, setForm] = useState<ClinicSettings>(() =>
    structuredClone(settingsStore.clinic),
  );

  // Валидация: у включённого дня конец позже начала.
  const badDay = form.schedule.find((d) => d.enabled && d.endMinute <= d.startMinute);
  const error = badDay
    ? `${WEEKDAYS[badDay.weekday - 1]}: конец рабочего дня должен быть позже начала`
    : null;

  function patch(next: Partial<ClinicSettings>) {
    setForm((f) => ({ ...f, ...next }));
  }
  function patchDay(weekday: number, next: Partial<ClinicSettings["schedule"][number]>) {
    patch({
      schedule: form.schedule.map((d) => (d.weekday === weekday ? { ...d, ...next } : d)),
    });
  }

  return (
    <>
      <SettingsHeader
        title="Клиника"
        description="Название, часовой пояс, граница отчётных суток и рабочие часы по дням недели. Исключения — праздники, санитарные и короткие дни."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[720px] flex-col gap-5">
          <Group title="Основное">
            <Field label="Название" htmlFor="clinic-name">
              <TextInput
                id="clinic-name"
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            <Field label="Часовой пояс" htmlFor="clinic-tz">
              <select
                id="clinic-tz"
                value={form.timezone}
                onChange={(e) => patch({ timezone: e.target.value })}
                className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Граница отчётных суток" hint="время, когда закрывается день в отчётах">
              <TimeInput
                minute={form.dayBoundaryMinute}
                onChange={(m) => patch({ dayBoundaryMinute: m })}
                ariaLabel="Граница отчётных суток"
              />
            </Field>
          </Group>

          <Group title="Рабочие часы" hint="кабинеты наследуют эти часы, если не заданы свои">
            <div className="flex flex-col gap-2">
              {form.schedule.map((day) => (
                <div
                  key={day.weekday}
                  className="grid grid-cols-[64px_auto_1fr] items-center gap-3"
                >
                  <div className="flex items-center gap-2">
                    <Toggle
                      checked={day.enabled}
                      onChange={(v) => patchDay(day.weekday, { enabled: v })}
                      label={WEEKDAYS[day.weekday - 1]}
                    />
                    <span className="text-sm">{WEEKDAYS[day.weekday - 1]}</span>
                  </div>
                  {day.enabled ? (
                    <div className="col-span-2 flex items-center gap-2">
                      <TimeInput
                        minute={day.startMinute}
                        onChange={(m) => patchDay(day.weekday, { startMinute: m })}
                        ariaLabel={`${WEEKDAYS[day.weekday - 1]} начало`}
                      />
                      <span className="text-text-subtle text-sm">—</span>
                      <TimeInput
                        minute={day.endMinute}
                        onChange={(m) => patchDay(day.weekday, { endMinute: m })}
                        ariaLabel={`${WEEKDAYS[day.weekday - 1]} конец`}
                      />
                    </div>
                  ) : (
                    <span className="text-text-subtle col-span-2 text-sm">выходной</span>
                  )}
                </div>
              ))}
            </div>
          </Group>

          <Group title="Исключения" hint="праздники, санитарные и короткие дни">
            {form.exceptions.length === 0 ? (
              <p className="text-text-subtle text-sm">Исключений нет.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {form.exceptions.map((ex) => (
                  <li key={ex.id} className="flex items-center gap-3">
                    <span className="num text-text-muted w-24 flex-none text-sm">{ex.date}</span>
                    <span className="flex-1 text-sm">{ex.label}</span>
                    <span className="text-text-subtle text-xs">
                      {ex.closed ? "закрыто" : "короткий день"}
                    </span>
                    <button
                      type="button"
                      onClick={() => patch({ exceptions: form.exceptions.filter((e) => e.id !== ex.id) })}
                      className="text-text-subtle hover:text-text text-sm"
                      aria-label={`Удалить ${ex.label}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={() =>
                patch({
                  exceptions: [
                    ...form.exceptions,
                    { id: `e${Date.now()}`, date: "2026-01-01", label: "Новый день", closed: true },
                  ],
                })
              }
              className="border-border text-text-muted hover:bg-hover self-start rounded-md border px-3 py-1.5 text-sm"
            >
              + Добавить исключение
            </button>
          </Group>

          <SaveBar
            error={error}
            onSave={() => {
              settingsStore.clinic = structuredClone(form);
            }}
          />
        </div>
      </div>
    </>
  );
}
