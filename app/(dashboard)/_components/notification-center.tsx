"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getNotifications,
  getVapidPublicKey,
  markAllNotificationsRead,
  markNotificationRead,
  sendTestPush,
  subscribePush,
  type NotificationItem,
} from "./notifications-actions";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/**
 * Центр уведомлений: колокольчик с числом, выпадающий список (под роль) и
 * включение push (PWA). Регистрирует service worker.
 *
 * Живёт в шапке (на телефоне) и в боковой панели (на десктопе), а не плавающей
 * кнопкой у нижнего края: там он накрывал кнопку отправки в чате и в инбоксе.
 */
/**
 * align задаёт, в какую сторону раскрывается панель. В боковом меню кнопка
 * стоит у левого края экрана, и панель шириной 300px, привязанная правым краем,
 * уезжала за границу окна — половину списка было не видно.
 */
export function NotificationCenter({ align = "right" }: { align?: "left" | "right" } = {}) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    let alive = true;
    const load = () => getNotifications().then((n) => alive && setItems(n)).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    // Отложенно (не синхронно в теле эффекта).
    void Promise.resolve().then(() => {
      if (alive && typeof Notification !== "undefined") setPushOn(Notification.permission === "granted");
    });
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  async function enablePush() {
    if (busy) return;
    setBusy(true);
    try {
      if (!("serviceWorker" in navigator) || typeof Notification === "undefined") return;
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
      const reg = await navigator.serviceWorker.ready;
      const key = await getVapidPublicKey();
      if (!key) return;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      });
      await subscribePush(JSON.parse(JSON.stringify(sub)));
      await sendTestPush();
      setPushOn(true);
    } catch {
      // тихо — уведомления опциональны
    } finally {
      setBusy(false);
    }
  }

  const count = items.length;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Уведомления"
        className="border-border text-text-muted hover:bg-hover relative flex h-9 w-9 flex-none items-center justify-center rounded-md border"
      >
        <span aria-hidden className="text-base leading-none">🔔</span>
        {count > 0 ? (
          <span className="bg-accent text-accent-contrast absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium">
            {count}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 -z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className={`border-border bg-surface absolute top-full z-50 mt-2 w-[300px] rounded-xl border p-2 shadow-lg max-md:w-[80vw] ${align === "left" ? "left-0" : "right-0"}`}>
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-sm font-medium">Уведомления</span>
              {!pushOn ? (
                <button
                  type="button"
                  onClick={enablePush}
                  disabled={busy}
                  className="text-accent-text text-2xs hover:underline disabled:opacity-50"
                >
                  {busy ? "…" : "включить push"}
                </button>
              ) : (
                <span className="text-text-subtle text-2xs">push включён</span>
              )}
            </div>
            {items.length === 0 ? (
              <p className="text-text-subtle px-2 py-3 text-sm">Новых уведомлений нет.</p>
            ) : (
              <>
                <ul className="flex max-h-[50vh] flex-col overflow-auto">
                  {items.map((n) => (
                    <li key={n.id} className="hover:bg-hover flex items-start gap-1 rounded-md">
                      <Link
                        href={n.url}
                        onClick={() => {
                          setOpen(false);
                          void markNotificationRead(n.id).then(setItems).catch(() => {});
                        }}
                        className="flex min-w-0 flex-1 items-start gap-2 px-2 py-2 text-sm"
                      >
                        <span
                          aria-hidden
                          className={`mt-1 flex-none ${n.urgent ? "text-accent-text" : "text-text-subtle"}`}
                        >
                          •
                        </span>
                        <span className="min-w-0">
                          <span className="block font-medium">{n.title}</span>
                          <span className="text-text-muted block text-xs">{n.text}</span>
                          {n.preview ? (
                            <span className="text-text-subtle mt-0.5 block text-xs italic">«{n.preview}»</span>
                          ) : null}
                        </span>
                      </Link>
                      <button
                        type="button"
                        onClick={() => {
                          void markNotificationRead(n.id).then(setItems).catch(() => {});
                        }}
                        aria-label="Пометить прочитанным"
                        title="Прочитано"
                        className="text-text-subtle hover:text-accent-text flex h-9 w-9 flex-none items-center justify-center text-sm"
                      >
                        ✓
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => {
                    void markAllNotificationsRead().then(setItems).catch(() => {});
                  }}
                  className="border-border-soft text-text-muted hover:bg-hover mt-1 w-full rounded-md border-t px-2 py-2 text-xs"
                >
                  Прочитать все
                </button>
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
