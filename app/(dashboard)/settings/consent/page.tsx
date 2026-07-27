"use client";

import { useState } from "react";
import { settingsStore } from "@/app/_data/settings";
import { Field, Group, SaveBar, SettingsHeader, Textarea, TextInput } from "../_components/ui";

export default function ConsentSettingsPage() {
  const initial = settingsStore.consent;
  const [form, setForm] = useState(() => structuredClone(initial));

  const versionChanged = form.version !== initial.version;
  const error = form.text.trim().length === 0 ? "Текст согласия не может быть пустым" : null;

  return (
    <>
      <SettingsHeader
        title="Согласие"
        description="Текст согласия на обработку персональных данных и его версия. При смене версии согласие запрашивается у пациентов заново."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[720px] flex-col gap-5">
          <Group>
            <Field label="Версия" hint="смена версии → новый запрос согласия" htmlFor="c-version">
              <TextInput
                id="c-version"
                value={form.version}
                onChange={(e) => setForm({ ...form, version: e.target.value })}
                className="max-w-[160px]"
              />
            </Field>
            <Field label="Ссылка на политику" htmlFor="c-url">
              <TextInput
                id="c-url"
                value={form.policyUrl}
                onChange={(e) => setForm({ ...form, policyUrl: e.target.value })}
                placeholder="https://…"
              />
            </Field>
            <Field label="Текст согласия" htmlFor="c-text">
              <Textarea
                id="c-text"
                rows={6}
                value={form.text}
                onChange={(e) => setForm({ ...form, text: e.target.value })}
              />
            </Field>
          </Group>

          {versionChanged ? (
            <p className="text-accent-text text-sm">
              Версия изменилась на «{form.version}» — после сохранения согласие
              будет запрошено у пациентов заново при следующем контакте.
            </p>
          ) : null}

          <SaveBar
            error={error}
            onSave={() => {
              settingsStore.consent = structuredClone(form);
            }}
          />
        </div>
      </div>
    </>
  );
}
