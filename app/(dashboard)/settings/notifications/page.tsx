"use client";

import { useState } from "react";
import { settingsStore, WEEKDAYS } from "@/app/_data/settings";
import { Field, Group, SaveBar, SettingsHeader, TimeInput, Toggle } from "../_components/ui";

const TYPE_LABEL: { key: "escalation" | "newInquiry" | "cancel"; label: string; hint: string }[] = [
  { key: "escalation", label: "Эскалация", hint: "агент зовёт человека" },
  { key: "newInquiry", label: "Новое обращение", hint: "сообщение или звонок" },
  { key: "cancel", label: "Отмена визита", hint: "запись отменили" },
];

export default function NotificationsSettingsPage() {
  const [form, setForm] = useState(() => structuredClone(settingsStore.notifications));

  function toggleBatch(weekday: number) {
    setForm((f) => ({
      ...f,
      batchWeekdays: f.batchWeekdays.includes(weekday)
        ? f.batchWeekdays.filter((d) => d !== weekday)
        : [...f.batchWeekdays, weekday].sort((a, b) => a - b),
    }));
  }

  return (
    <>
      <SettingsHeader
        title="Уведомления"
        description="Когда доставлять уведомления: сразу или копить до начала смены. По умолчанию воскресенье копится до понедельника. Ночные часы — не беспокоить."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[720px] flex-col gap-5">
          <Group title="Расписание" hint="в выбранные дни уведомления копятся до начала следующей смены">
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((label, i) => {
                const weekday = i + 1;
                const batched = form.batchWeekdays.includes(weekday);
                return (
                  <button
                    key={weekday}
                    type="button"
                    onClick={() => toggleBatch(weekday)}
                    className={`rounded-md border px-3 py-1.5 text-sm ${
                      batched
                        ? "border-accent-border bg-accent-tint text-accent-text font-medium"
                        : "border-border text-text-muted hover:bg-hover"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="text-text-subtle text-xs">
              Выделенные дни — копим до утра. Остальные — доставляем сразу.
            </p>
          </Group>

          <Group title="Не беспокоить" hint="в эти часы push не приходит">
            <Field label="Ночные часы">
              <div className="flex items-center gap-2">
                <TimeInput
                  minute={form.quietFrom}
                  onChange={(m) => setForm({ ...form, quietFrom: m })}
                  ariaLabel="Тихие часы с"
                />
                <span className="text-text-subtle text-sm">—</span>
                <TimeInput
                  minute={form.quietTo}
                  onChange={(m) => setForm({ ...form, quietTo: m })}
                  ariaLabel="Тихие часы до"
                />
              </div>
            </Field>
          </Group>

          <Group title="Кто что получает" hint="типы уведомлений">
            {TYPE_LABEL.map((t) => (
              <Field key={t.key} label={t.label} hint={t.hint}>
                <Toggle
                  checked={form[t.key]}
                  onChange={(v) => setForm({ ...form, [t.key]: v })}
                  label={t.label}
                />
              </Field>
            ))}
          </Group>

          <Group title="Устройства" hint="куда приходят push-уведомления">
            <ul className="flex flex-col gap-2">
              <li className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm">Chrome · MacBook Ирины</p>
                  <p className="text-text-subtle text-xs">подключено 20 июля</p>
                </div>
                <button type="button" className="text-text-subtle hover:text-text text-sm">
                  Отключить
                </button>
              </li>
            </ul>
            <button
              type="button"
              className="border-border text-text-muted hover:bg-hover self-start rounded-md border px-3 py-1.5 text-sm"
            >
              + Подключить это устройство
            </button>
          </Group>

          <SaveBar
            onSave={() => {
              settingsStore.notifications = structuredClone(form);
            }}
          />
        </div>
      </div>
    </>
  );
}
