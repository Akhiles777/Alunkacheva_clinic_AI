"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { linkPatientDb, renameContactDb, searchPatientsForLink } from "./actions";
import type { Dialog } from "@/app/_data/store";

/**
 * Кто на том конце: имя контакта и связь с карточкой клиента.
 *
 * Диалог из мессенджера приходит без карточки — только с именем из профиля,
 * а раньше и без него («Без имени»). Здесь администратор либо переименовывает
 * контакт, либо привязывает переписку к существующей карточке, либо заводит
 * новую. После привязки видна вся история визитов этого человека.
 */
export function ContactPanel({ dialog, onChanged }: { dialog: Dialog; onChanged: () => void }) {
  // key по диалогу в родителе гарантирует, что при переключении переписки
  // состояние панели создаётся заново — эффект для сброса не нужен.
  const [mode, setMode] = useState<"idle" | "rename" | "link">("idle");
  const [name, setName] = useState(dialog.name);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ id: string; name: string; phone: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (mode !== "link") return;
    let alive = true;
    searchPatientsForLink(query)
      .then((r) => alive && setFound(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mode, query]);

  function run(action: () => Promise<unknown>) {
    setError(null);
    start(async () => {
      try {
        await action();
        setMode("idle");
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Не удалось сохранить");
      }
    });
  }

  if (mode === "rename") {
    return (
      <div className="border-border-soft flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Имя контакта"
          className="border-border-input bg-surface min-w-0 flex-1 rounded-md border px-2.5 py-1.5 text-sm outline-none"
        />
        <button
          type="button"
          disabled={pending || !name.trim()}
          onClick={() => run(() => renameContactDb(dialog.id, name))}
          className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-45"
        >
          Сохранить
        </button>
        <button type="button" onClick={() => setMode("idle")} className="text-text-subtle hover:text-text text-xs">
          Отмена
        </button>
        {error ? <span className="text-accent-text w-full text-xs">{error}</span> : null}
      </div>
    );
  }

  if (mode === "link") {
    return (
      <div className="border-border-soft flex flex-col gap-2 border-b px-5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Найти клиента по имени или телефону"
            className="border-border-input bg-surface min-w-0 flex-1 rounded-md border px-2.5 py-1.5 text-sm outline-none"
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => linkPatientDb(dialog.id, { createName: dialog.name }))}
            className="border-border text-text-muted hover:bg-hover rounded-md border px-3 py-1.5 text-xs disabled:opacity-45"
          >
            Завести новую карточку
          </button>
          <button type="button" onClick={() => setMode("idle")} className="text-text-subtle hover:text-text text-xs">
            Отмена
          </button>
        </div>
        {error ? <span className="text-accent-text text-xs">{error}</span> : null}
        <div className="flex flex-wrap gap-1.5">
          {found.length === 0 ? (
            <span className="text-text-subtle text-xs">Никого не нашлось.</span>
          ) : (
            found.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={pending}
                onClick={() => run(() => linkPatientDb(dialog.id, { patientId: p.id }))}
                className="border-border text-text-muted hover:bg-hover rounded-md border px-2.5 py-1 text-xs"
              >
                {p.name}
                {p.phone ? ` · ${p.phone}` : ""}
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="border-border-soft flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-2 text-xs">
      {dialog.patientId ? (
        <Link href={`/patients/${dialog.patientId}`} className="text-accent-text hover:underline">
          Карточка клиента
        </Link>
      ) : (
        <span className="text-text-subtle">Не привязан к карточке клиента</span>
      )}
      {/* Номер виден сразу: раньше администратор не знал, с какого телефона
          пишут, пока не откроет карточку — а её могло и не быть. */}
      {dialog.phone ? (
        <a href={`tel:${dialog.phone}`} className="num text-text-muted hover:text-text">
          {dialog.phone}
        </a>
      ) : null}
      <button type="button" onClick={() => setMode("rename")} className="text-text-muted hover:text-text">
        Переименовать
      </button>
      {!dialog.patientId ? (
        <button type="button" onClick={() => setMode("link")} className="text-text-muted hover:text-text">
          Привязать к клиенту
        </button>
      ) : null}
    </div>
  );
}
