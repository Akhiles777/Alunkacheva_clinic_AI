"use client";

import { useEffect, useState } from "react";
import { setApptSource, type Appt } from "@/app/_data/store";
import { getSourceOptions } from "@/app/(dashboard)/schedule/actions";

/**
 * Откуда пришёл пациент — прямо в строке визита.
 *
 * В YCLIENTS это поле не заполняет никто, и разрез воронки по источникам
 * показывал одну строку «неизвестен» на все семьсот записей. Мы выводим
 * источник из переписки, но переписка есть не у всех: звонок и приход с улицы
 * следов не оставляют, и назвать их может только человек.
 *
 * Три состояния подписаны по-разному, потому что это три разных утверждения:
 * проставленное человеком, выведенное из переписки и неизвестное. Выведенное
 * подписано словом «из переписки» — чтобы администратор понимал, что правит
 * догадку системы, а не чужой ответ.
 */

/** Справочник тянем один раз на страницу, а не на каждую строку. */
let cache: Promise<{ code: string; title: string }[]> | null = null;
function options() {
  cache ??= getSourceOptions();
  return cache;
}

export interface SourceState {
  code: string | null;
  title: string | null;
  confidence: "MANUAL" | "DERIVED" | "UNKNOWN";
}

/** Строка визита в списке дня. */
export function VisitSource({ appt, readOnly }: { appt: Appt; readOnly?: boolean }) {
  return (
    <SourcePicker
      state={{
        code: appt.sourceCode ?? null,
        title: appt.sourceTitle ?? null,
        confidence: appt.sourceConfidence ?? "UNKNOWN",
      }}
      readOnly={readOnly}
      onPick={(code, title) => setApptSource(appt.id, code, title)}
    />
  );
}

export function SourcePicker({
  state,
  readOnly,
  onPick,
}: {
  state: SourceState;
  readOnly?: boolean;
  onPick: (code: string | null, title: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ code: string; title: string }[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    options().then(
      (rows) => alive && setList(rows),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [open]);

  const confidence = state.confidence;
  const label = state.title ?? "источник неизвестен";
  const hint =
    confidence === "MANUAL" ? "" : confidence === "DERIVED" ? " · из переписки" : "";

  if (readOnly) {
    return (
      <div className="text-text-subtle mt-1.5 truncate text-2xs">
        {label}
        {hint}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-text-subtle mt-1.5 block max-w-full truncate text-2xs hover:underline"
        title={
          confidence === "DERIVED"
            ? "Источник выведен из переписки рядом с созданием записи. Нажмите, чтобы поправить."
            : confidence === "MANUAL"
              ? "Источник проставлен вручную. Выгрузка его не меняет."
              : "Откуда пришёл пациент — неизвестно. Нажмите, чтобы указать."
        }
      >
        {label}
        {hint}
      </button>
    );
  }

  return (
    <div className="mt-1.5">
      {failed ? (
        <div className="text-text-muted text-2xs">Справочник источников не загрузился.</div>
      ) : list.length === 0 ? (
        <div className="text-text-subtle text-2xs">Загружаем источники…</div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {list.map((s) => (
            <button
              key={s.code}
              type="button"
              onClick={() => {
                onPick(s.code, s.title);
                setOpen(false);
              }}
              className={`rounded-md border px-2 py-0.5 text-2xs ${
                state.code === s.code
                  ? "border-accent text-accent-text"
                  : "border-border-input text-text-muted hover:border-border"
              }`}
            >
              {s.title}
            </button>
          ))}
          {/*
            «Не знаю» — полноценный ответ, а не отсутствие кнопки. Без него
            ошибочный клик нечем отменить, и администратор оставляет неверный
            источник: он честнее не выглядит, но врёт в отчёте.
          */}
          <button
            type="button"
            onClick={() => {
              onPick(null, null);
              setOpen(false);
            }}
            className="border-border-input text-text-subtle hover:border-border rounded-md border px-2 py-0.5 text-2xs"
          >
            не знаю
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-text-subtle mt-1 text-2xs hover:underline"
      >
        отмена
      </button>
    </div>
  );
}
