"use client";

import { useEffect, useState, useTransition } from "react";
import { Group } from "../_components/ui";
import { getDevices, removeDevice, type DeviceRow } from "./devices-actions";
import { getVapidPublicKey, sendTestPush, subscribePush } from "@/app/(dashboard)/_components/notifications-actions";

/**
 * Устройства для push. Раздел показывает реальные подписки текущего сотрудника
 * и умеет подключить то устройство, с которого он сейчас зашёл.
 *
 * Push устроен так, что подписка привязана к конкретному браузеру на
 * конкретном устройстве: подключить телефон, сидя за компьютером, нельзя —
 * это ограничение самих браузеров, а не платформы. Поэтому здесь честно
 * написано, что делать.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function Devices() {
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    getDevices()
      .then((r) => alive && setRows(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() =>
      setSupported(typeof Notification !== "undefined" && "serviceWorker" in navigator),
    );
    return () => cancelAnimationFrame(id);
  }, []);

  function connect() {
    setStatus(null);
    start(async () => {
      try {
        if (!("serviceWorker" in navigator) || typeof Notification === "undefined") {
          setStatus("Этот браузер не умеет push-уведомления.");
          return;
        }
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setStatus("Браузер не дал разрешение. Разрешите уведомления в настройках сайта и повторите.");
          return;
        }
        await navigator.serviceWorker.register("/sw.js").catch(() => {});
        const reg = await navigator.serviceWorker.ready;
        const key = await getVapidPublicKey();
        if (!key) {
          setStatus("На сервере не заданы ключи VAPID — push отправлять нечем. Проверьте /api/health.");
          return;
        }
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
        });
        await subscribePush(JSON.parse(JSON.stringify(sub)), navigator.userAgent);
        const res = await sendTestPush();
        setRows(await getDevices(sub.endpoint));
        setStatus(
          res.sent > 0
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
                onClick={() => start(async () => setRows(await removeDevice(d.id)))}
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
