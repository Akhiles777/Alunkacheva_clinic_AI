"use client";

import { useState, useTransition } from "react";
import { Field, Group, Toggle } from "../_components/ui";
import { saveServices, type ServiceRow, type ServicesPayload } from "./actions";
import { reportMaybeStale } from "@/lib/client/stale-build";

const KIND_OPTIONS: { value: ServiceRow["kind"]; label: string }[] = [
  { value: "OSTEOPATHY", label: "Остеопатия" },
  { value: "IV_THERAPY", label: "IV-терапия" },
  { value: "BIOFEEDBACK", label: "БОС-терапия" },
  { value: "NEUROMEDITATION", label: "Нейромедитация" },
  { value: "LAB", label: "Анализы" },
  { value: "OTHER", label: "Другое" },
];

/** Пустое поле и мусор в нём — это ноль, а не NaN: NaN базу роняет. */
function numberOrZero(raw: string): number {
  const n = Number(raw.replace(/\s/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function blankService(): ServiceRow {
  return {
    id: `new-${Date.now()}`,
    title: "Новая услуга",
    kind: "OTHER",
    price: 0,
    // Заведённая у нас услуга в YCLIENTS не существует: её цена наша по определению.
    priceLocked: true,
    yclientsPrice: null,
    durationMin: 30,
    isActive: true,
    isCourse: false,
    defaultSessions: null,
    stalledAfterDays: null,
    roomIds: [],
  };
}

export function ServicesClient({ initial }: { initial: ServicesPayload }) {
  const [services, setServices] = useState<ServiceRow[]>(initial.services);
  /** Что было на экране при загрузке: удалять можно только это. */
  const [knownIds] = useState(() => initial.services.map((s) => s.id));
  const { roomOptions } = initial;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function patch(id: string, next: Partial<ServiceRow>) {
    setServices((ss) => ss.map((s) => (s.id === id ? { ...s, ...next } : s)));
    setSaved(false);
    setError(null);
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
    setSaved(false);
  }
  function addService() {
    setServices((ss) => [...ss, blankService()]);
    setSaved(false);
  }
  function removeService(id: string) {
    setServices((ss) => ss.filter((s) => s.id !== id));
    setSaved(false);
  }

  function save() {
    startTransition(async () => {
      try {
        const res = await saveServices(services, knownIds);
        if (!res.ok) {
          setError(res.error);
          setSaved(false);
          return;
        }
        setServices(res.payload.services);
        setSaved(true);
        setError(null);
        setNotice(res.notice ?? null);
      } catch (e) {
        /**
         * Сюда долетает только неожиданное: проверки возвращаются данными.
         * Чаще всего это устаревшая вкладка — серверного действия с таким
         * идентификатором на новой сборке уже нет. Говорим сторожу, он
         * предложит обновиться.
         */
        reportMaybeStale(e);
        setError(
          e instanceof Error
            ? `${e.message} Если ошибка повторяется, обновите страницу: возможно, вышла новая версия.`
            : "Не удалось сохранить",
        );
      }
    });
  }

  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="num text-text-subtle text-xs">{services.length} услуг</span>
        <button
          type="button"
          onClick={addService}
          className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3.5 py-2 text-sm font-medium"
        >
          + Услуга
        </button>
      </div>

      {error ? <p className="text-accent-text text-sm">{error}</p> : null}
      {notice ? <p className="text-text-muted text-sm">{notice}</p> : null}

      {services.map((s) => (
        <Group key={s.id}>
          <Field label="Название" htmlFor={`${s.id}-title`}>
            <input
              id={`${s.id}-title`}
              value={s.title}
              onChange={(e) => patch(s.id, { title: e.target.value })}
              className="border-border-input bg-surface w-full rounded-md border px-3 py-2 text-sm outline-none"
            />
          </Field>
          <Field label="Направление" htmlFor={`${s.id}-kind`}>
            <select
              id={`${s.id}-kind`}
              value={s.kind}
              onChange={(e) => patch(s.id, { kind: e.target.value as ServiceRow["kind"] })}
              className="border-border-input bg-surface rounded-md border px-2.5 py-2 text-sm outline-none"
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
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
                  onChange={(e) => patch(s.id, { durationMin: numberOrZero(e.target.value) })}
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
                  /*
                    Пустое поле даёт NaN, а стереть цену, чтобы набрать новую, —
                    обычное движение. Раньше на нём сохранение обрывалось
                    безымянной ошибкой сервера: база не пишет NaN в деньги.
                  */
                  onChange={(e) => patch(s.id, { price: numberOrZero(e.target.value) })}
                  className="border-border-input bg-surface num w-24 rounded-md border px-2 py-1.5 text-sm outline-none"
                />
                <span className="text-text-subtle text-2xs">₽</span>
              </label>
              {/*
                Чья это цена — наша или YCLIENTS.

                Без пометки правка выглядела бессмысленной: экран позволял её
                изменить, а выгрузка через четверть часа возвращала прежнее
                значение. Теперь наша цена держится, и видно, от чего она
                отличается и как вернуть провайдерскую.
              */}
              {s.priceLocked && !s.id.startsWith("new-") ? (
                <span className="text-text-subtle flex items-center gap-1.5 text-2xs">
                  <span title="Цена задана в клинике: выгрузка её не перезапишет">наша цена</span>
                  {s.yclientsPrice !== null && s.yclientsPrice !== s.price ? (
                    <button
                      type="button"
                      onClick={() =>
                        patch(s.id, { price: s.yclientsPrice ?? 0, priceLocked: false })
                      }
                      className="border-border hover:bg-hover rounded-md border px-1.5 py-0.5"
                      title="Вернуть цену, которую отдаёт YCLIENTS, и снова обновлять её выгрузкой"
                    >
                      в YCLIENTS {s.yclientsPrice} ₽
                    </button>
                  ) : null}
                </span>
              ) : null}
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

          <Field label="Кабинеты" hint="где услуга может проводиться — знаменатель загрузки">
            {roomOptions.length === 0 ? (
              <p className="text-text-subtle text-sm">Сначала добавьте кабинеты.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {roomOptions.map((room) => {
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
            )}
          </Field>

          <div className="border-border-soft flex justify-end border-t pt-3">
            <button
              type="button"
              onClick={() => removeService(s.id)}
              className="text-text-subtle hover:text-text text-sm"
            >
              Удалить услугу
            </button>
          </div>
        </Group>
      ))}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isPending ? "Сохраняем…" : "Сохранить"}
        </button>
        {saved && !isPending ? <span className="text-text-muted text-sm">Сохранено</span> : null}
      </div>
    </div>
  );
}
