"use client";

import { useEffect, useState, useTransition } from "react";
import { Group } from "../_components/ui";
import { previewDemoPurge, purgeDemoData, type PurgePreview } from "./purge-actions";

/**
 * Очистка демонстрационных данных перед запуском.
 *
 * Поштучно демо не убрать: услуги, кабинеты и источники защищены от удаления,
 * пока с ними связана история визитов, — и это правильная защита, отключать
 * её нельзя. Поэтому очистка сделана отдельным осознанным действием: сначала
 * показываем, что именно исчезнет, потом просим ввести слово подтверждения.
 */
export function PurgeBlock() {
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState("");
  const [done, setDone] = useState<PurgePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    previewDemoPurge().then(setPreview).catch(() => {});
  }, []);

  if (done) {
    return (
      <Group title="Демонстрационные данные" hint="очистка выполнена">
        <p className="text-sm">
          Удалено: визитов {done.appointments}, пациентов {done.patients}, демонстрационных
          специалистов {done.demoStaff}. Настройки клиники, кабинеты, услуги, источники, учётные
          записи и база знаний остались на месте.
        </p>
        <p className="text-text-subtle text-sm">Обновите страницу, чтобы увидеть чистые списки.</p>
      </Group>
    );
  }

  return (
    <Group
      title="Демонстрационные данные"
      hint="убрать придуманные визиты и пациентов перед началом работы"
    >
      {preview ? (
        <p className="text-text-muted text-sm">
          Сейчас в базе: визитов <b className="num text-text">{preview.appointments}</b>, пациентов{" "}
          <b className="num text-text">{preview.patients}</b>, демонстрационных специалистов{" "}
          <b className="num text-text">{preview.demoStaff}</b>.
        </p>
      ) : (
        <p className="text-text-subtle text-sm">Считаем…</p>
      )}

      <p className="text-text-subtle text-sm">
        Очистка удалит визиты, пациентов с телефонами и заметками, демонстрационных специалистов со
        ставками и выплатами. Клиника, кабинеты, услуги, источники, сотрудники с доступом, база
        знаний и переписка останутся. Действие необратимо.
      </p>

      {error ? <p className="text-accent-text text-sm">{error}</p> : null}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="border-border text-text-muted hover:bg-hover self-start rounded-md border px-3 py-1.5 text-sm"
        >
          Очистить демонстрационные данные
        </button>
      ) : (
        <div className="flex flex-wrap items-end gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-text-subtle text-2xs">Введите слово УДАЛИТЬ для подтверждения</span>
            <input
              value={word}
              onChange={(e) => setWord(e.target.value)}
              placeholder="УДАЛИТЬ"
              className="border-border-input bg-surface w-44 rounded-md border px-3 py-2 text-sm outline-none"
            />
          </label>
          <button
            type="button"
            disabled={pending || word.trim().toUpperCase() !== "УДАЛИТЬ"}
            onClick={() =>
              start(async () => {
                try {
                  setDone(await purgeDemoData(word));
                  setError(null);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Не удалось очистить");
                }
              })
            }
            className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
          >
            {pending ? "Очищаем…" : "Удалить безвозвратно"}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setWord("");
            }}
            className="text-text-subtle hover:text-text px-2 py-2 text-sm"
          >
            Отмена
          </button>
        </div>
      )}
    </Group>
  );
}
