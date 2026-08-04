"use client";

import { useEffect, useState, useTransition } from "react";
import { Group } from "../_components/ui";
import { getDevices, removeDevice, type DeviceRow } from "./devices-actions";
import { sendTestPush } from "@/app/(dashboard)/_components/notifications-actions";
import {
  announcePushChange,
  enablePush,
  PUSH_CHANGED,
  pushSupported,
} from "@/app/(dashboard)/_components/push-subscribe";

/**
 * Устройства для push. Раздел показывает реальные подписки текущего сотрудника
 * и умеет подключить то устройство, с которого он сейчас зашёл.
 *
 * Push устроен так, что подписка привязана к конкретному браузеру на
 * конкретном устройстве: подключить телефон, сидя за компьютером, нельзя —
 * это ограничение самих браузеров, а не платформы. Поэтому здесь честно
 * написано, что делать.
 *
 * Само подключение живёт в общем модуле push-subscribe: тот же код работает
 * при входе. Раньше эта логика была написана трижды и успела разойтись.
 */

export function Devices() {
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    // Список обновляется и по событию: устройство могли подключить полосой
    // при входе, и тогда оно должно появиться здесь без перезагрузки.
    const load = () =>
      getDevices()
        .then((r) => alive && setRows(r))
        .catch(() => {});
    load();
    window.addEventListener(PUSH_CHANGED, load);
    return () => {
      alive = false;
      window.removeEventListener(PUSH_CHANGED, load);
    };
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => setSupported(pushSupported()));
    return () => cancelAnimationFrame(id);
  }, []);

  function connect() {
    setStatus(null);
    start(async () => {
      try {
        const res = await enablePush();
        if (!res.ok) {
          setStatus(res.reason);
          return;
        }
        const test = await sendTestPush();
        setRows(await getDevices(res.endpoint));
        setStatus(
          test.sent > 0
            ? "Устройство подключено — проверочное уведомление отправлено."
            : "Устройство подключено, но проверочное уведомление не ушло. Проверьте /api/health.",
        );
      } catch {
        setStatus("Не удалось подключить устройство. Попробуйте ещё раз.");
      }
    });
  }

  return (
    <Group title="Устройства" hint="куда приходят push-уведомления">
      {rows.length === 0 ? (
        <p className="text-text-subtle text-sm">
          Пока ни одного устройства. Нажмите «Подключить это устройство» — уведомления начнут
          приходить сюда.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((d) => (
            <li key={d.id} className="border-border-soft flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {d.title}
                  {d.isCurrent ? " · это устройство" : ""}
                </p>
                <p className="text-text-subtle text-xs">подключено {d.addedAt}</p>
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    setRows(await removeDevice(d.id));
                    // Колокольчик должен сразу показать, что push выключен.
                    announcePushChange();
                  })
                }
                className="text-text-subtle hover:text-text flex-none text-sm disabled:opacity-45"
              >
                Отключить
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={connect}
          disabled={pending || !supported}
          className="border-border text-text-muted hover:bg-hover rounded-md border px-3 py-1.5 text-sm disabled:opacity-45"
        >
          {pending ? "Подключаем…" : "+ Подключить это устройство"}
        </button>
        {status ? <span className="text-text-muted text-xs">{status}</span> : null}
      </div>

      <p className="text-text-subtle text-xs">
        Подключать нужно каждое устройство отдельно: браузер привязывает подписку к себе. Чтобы
        уведомления приходили на телефон, откройте платформу на телефоне и нажмите эту кнопку там.
      </p>
    </Group>
  );
}
