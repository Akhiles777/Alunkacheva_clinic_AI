"use client";

import { useState, useTransition } from "react";
import { Group } from "../_components/ui";
import {
  checkConnection,
  connectYclients,
  saveCredential,
  selectYclientsBranch,
  type IntegrationView,
  type ProviderId,
} from "./actions";

const WHATSAPP_PROVIDERS = ["Wazzup24", "Green API"];

/**
 * Подключение к YCLIENTS логином и паролем.
 *
 * Пользовательский токен YCLIENTS выдаёт только в обмен на учётные данные
 * сотрудника. Раньше его получали запросом руками и вписывали в базу — теперь
 * это делает платформа. Логин и пароль никуда не сохраняются: они нужны на
 * один запрос и в браузере не остаются.
 */
function YclientsConnect({ onDone }: { onDone: (next: IntegrationView[]) => void }) {
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<{ id: number; title: string }[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await connectYclients(login, password);
      onDone(res.view);
      if (!res.ok) {
        setError(res.error ?? "Не удалось подключиться");
        return;
      }
      // Пароль в памяти держать незачем: он больше не понадобится.
      setPassword("");
      setBranches(res.branches ?? []);
      setChosen(res.selectedBranchId ?? null);
      if (res.error) setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  async function pick(id: number) {
    setBusy(true);
    try {
      onDone(await selectYclientsBranch(id));
      setChosen(id);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border-border text-text hover:bg-hover self-start rounded-md border px-3 py-2 text-sm font-medium"
      >
        Подключить по логину и паролю
      </button>
    );
  }

  return (
    <div className="border-border bg-raise flex flex-col gap-2.5 rounded-lg border p-3.5">
      <p className="text-text-muted text-xs leading-snug">
        Логин и пароль сотрудника YCLIENTS. Они нужны один раз, чтобы получить
        пользовательский токен, и нигде не сохраняются.
      </p>
      <input
        value={login}
        onChange={(e) => setLogin(e.target.value)}
        placeholder="Логин или телефон"
        autoComplete="off"
        className="border-border-input bg-surface w-full rounded-md border px-3 py-1.5 text-sm outline-none"
      />
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        placeholder="Пароль"
        autoComplete="off"
        className="border-border-input bg-surface w-full rounded-md border px-3 py-1.5 text-sm outline-none"
      />
      {error ? <p className="text-danger-text text-xs">{error}</p> : null}
      {branches.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-text-muted text-xs">Выберите филиал:</span>
          {branches.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => pick(b.id)}
              disabled={busy}
              className={`rounded-md border px-3 py-1.5 text-left text-sm ${
                chosen === b.id ? "border-accent bg-accent-tint" : "border-border hover:bg-hover"
              }`}
            >
              {b.title}
            </button>
          ))}
        </div>
      ) : null}
      {chosen !== null && branches.length <= 1 ? (
        <p className="text-text-muted text-xs">Филиал определён автоматически.</p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={connect}
          disabled={busy}
          className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-45"
        >
          {busy ? "Подключаем…" : "Подключить"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="border-border text-text-muted hover:bg-hover rounded-md border px-3 py-1.5 text-sm"
        >
          Закрыть
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: IntegrationView["status"] }) {
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

function Block({
  block,
  onSave,
  onCheck,
  onRefresh,
  pending,
}: {
  block: IntegrationView;
  onSave: (keyName: string, value: string) => void;
  onCheck: () => void;
  onRefresh: (next: IntegrationView[]) => void;
  pending: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [provider, setProvider] = useState(WHATSAPP_PROVIDERS[0]);

  return (
    <Group>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{block.title}</h2>
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
                  {field.set ? "•••••••••••• задано" : "не задано"}
                </span>
              )}
            </div>
            {editing === field.keyName ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={draft.trim().length === 0 || pending}
                  onClick={() => {
                    onSave(field.keyName, draft);
                    setEditing(null);
                    setDraft("");
                  }}
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

      {block.provider === "yclients" ? <YclientsConnect onDone={onRefresh} /> : null}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={onCheck}
          disabled={pending}
          className="border-border text-text hover:bg-hover rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-45"
        >
          {pending ? "Проверяем связь…" : "Проверить связь"}
        </button>
        {block.lastCheckedAt ? (
          <span className="text-text-subtle text-xs">проверено {block.lastCheckedAt}</span>
        ) : null}
      </div>
    </Group>
  );
}

export function IntegrationsClient({ initial }: { initial: IntegrationView[] }) {
  const [blocks, setBlocks] = useState(initial);
  const [pendingProvider, setPendingProvider] = useState<ProviderId | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex max-w-[680px] flex-col gap-4">
      {blocks.map((block) => (
        <Block
          key={block.provider}
          block={block}
          pending={isPending && pendingProvider === block.provider}
          onSave={(keyName, value) => {
            setPendingProvider(block.provider);
            startTransition(async () => {
              setBlocks(await saveCredential(block.provider, keyName, value));
            });
          }}
          onCheck={() => {
            setPendingProvider(block.provider);
            startTransition(async () => {
              setBlocks(await checkConnection(block.provider));
            });
          }}
          onRefresh={setBlocks}
        />
      ))}
      <p className="text-text-subtle text-xs">
        Значения шифруются на сервере (AES-256-GCM) и хранятся в базе. Полностью
        не отображаются никогда.
      </p>
    </div>
  );
}
