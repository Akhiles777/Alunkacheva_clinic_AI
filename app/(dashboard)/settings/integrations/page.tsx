"use client";

import { useRef, useState } from "react";
import { credentialMask, INTEGRATIONS, type IntegrationBlock } from "@/app/_data/settings";
import { Group, SettingsHeader } from "../_components/ui";

const WHATSAPP_PROVIDERS = ["Wazzup24", "Green API"];

function StatusBadge({ status }: { status: IntegrationBlock["status"] }) {
  if (status === "ok") {
    return (
      <span className="text-text-muted inline-flex items-center gap-1.5 text-xs">
        <span aria-hidden className="bg-text-subtle h-1.5 w-1.5 rounded-full" />
        связь есть
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="text-accent-text inline-flex items-center gap-1.5 text-xs font-medium">
        <span aria-hidden className="border-accent-text h-1.5 w-1.5 rounded-full border" />
        нет связи
      </span>
    );
  }
  return <span className="text-text-subtle text-xs">не проверено</span>;
}

function Block({ initial }: { initial: IntegrationBlock }) {
  const [block, setBlock] = useState<IntegrationBlock>(() => structuredClone(initial));
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [provider, setProvider] = useState(WHATSAPP_PROVIDERS[0]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function check() {
    setChecking(true);
    if (timer.current) clearTimeout(timer.current);
    // Проверка соединения — сразу пишем результат в status (§4.6).
    timer.current = setTimeout(() => {
      const ok = block.fields.every((f) => f.encrypted);
      setBlock((b) => ({
        ...b,
        status: ok ? "ok" : "failed",
        lastCheckedAt: "только что",
      }));
      setChecking(false);
    }, 1000);
  }

  function saveField(keyName: string) {
    setBlock((b) => ({
      ...b,
      // Реальное значение шифруется на сервере (AES-256-GCM). Здесь — метка,
      // что значение задано; наружу отдаём только маску.
      status: "unknown",
      fields: b.fields.map((f) => (f.keyName === keyName ? { ...f, encrypted: "set" } : f)),
    }));
    setEditing(null);
    setDraft("");
  }

  return (
    <Group>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">{block.title}</h2>
          {block.extra ? <p className="text-text-subtle mt-0.5 text-xs">{block.extra}</p> : null}
        </div>
        <StatusBadge status={block.status} />
      </div>

      {block.provider === "whatsapp" ? (
        <div className="flex items-center gap-3">
          <span className="text-sm">Провайдер</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="border-border-input bg-surface rounded-md border px-2.5 py-1.5 text-sm outline-none"
          >
            {WHATSAPP_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <ul className="flex flex-col gap-2">
        {block.fields.map((field) => (
          <li key={field.keyName} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <div className="min-w-0">
              <span className="text-sm">{field.label}</span>
              {editing === field.keyName ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Введите новое значение"
                  className="border-border-input bg-surface mt-1 w-full rounded-md border px-3 py-1.5 text-sm outline-none"
                />
              ) : (
                <span className="num text-text-subtle mt-0.5 block text-xs">
                  {credentialMask(field)}
                </span>
              )}
            </div>
            {editing === field.keyName ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => saveField(field.keyName)}
                  disabled={draft.trim().length === 0}
                  className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-45"
                >
                  Сохранить
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setDraft("");
                  }}
                  className="text-text-muted hover:text-text px-2 text-sm"
                >
                  Отмена
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditing(field.keyName);
                  setDraft("");
                }}
                className="border-border text-text-muted hover:bg-hover rounded-md border px-3 py-1.5 text-sm"
              >
                Изменить
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={check}
          disabled={checking}
          className="border-border text-text hover:bg-hover rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-45"
        >
          {checking ? "Проверяем связь…" : "Проверить связь"}
        </button>
        {block.lastCheckedAt ? (
          <span className="text-text-subtle text-xs">проверено {block.lastCheckedAt}</span>
        ) : null}
      </div>
    </Group>
  );
}

export default function IntegrationsSettingsPage() {
  return (
    <>
      <SettingsHeader
        title="Интеграции"
        description="YCLIENTS, Instagram, WhatsApp: статус соединения и проверка связи. Все значения хранятся зашифрованными и показываются маской — полностью не отображаются никогда."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[680px] flex-col gap-4">
          {INTEGRATIONS.map((block) => (
            <Block key={block.provider} initial={block} />
          ))}
        </div>
      </div>
    </>
  );
}
