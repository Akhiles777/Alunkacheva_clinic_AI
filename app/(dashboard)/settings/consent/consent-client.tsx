"use client";

import { useState, useTransition } from "react";
import { Field, Group, SaveBar, Textarea, TextInput } from "../_components/ui";
import { saveConsent, type ConsentData } from "./actions";

export function ConsentClient({ initial }: { initial: ConsentData }) {
  const [form, setForm] = useState<ConsentData>(initial);
  const [savedVersion, setSavedVersion] = useState(initial.version);
  const [isPending, startTransition] = useTransition();

  const versionChanged = form.version.trim() !== savedVersion;
  const error = form.text.trim().length === 0 ? "Текст согласия не может быть пустым" : null;

  return (
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
          Версия изменилась на «{form.version}» — после сохранения согласие будет
          запрошено у пациентов заново при следующем контакте.
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <SaveBar
          error={error}
          onSave={() => {
            startTransition(async () => {
              const res = await saveConsent(form);
              setSavedVersion(form.version.trim());
              void res;
            });
          }}
        />
        {isPending ? <span className="text-text-subtle text-sm">сохраняем…</span> : null}
      </div>
    </div>
  );
}
