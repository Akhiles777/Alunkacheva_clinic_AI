"use client";

import { getVapidPublicKey, subscribePush } from "./notifications-actions";

/**
 * Подключение устройства к push. Один модуль на всё приложение: и на вход, и
 * на раздел настроек. Раньше логика жила только в настройках, и сотрудник,
 * который туда не заходил, оставался без уведомлений, не зная об этом.
 *
 * Подписка привязана к паре «браузер + устройство»: подключить телефон с
 * компьютера нельзя, это ограничение самих браузеров.
 */

/** Почему подключить не удалось — текстом, который можно показать сотруднику. */
export type PushResult =
  | { ok: true; endpoint: string }
  | { ok: false; reason: string; blocked: boolean };

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function bufferToBase64Url(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Событие «подписка изменилась». Состояние push нужно сразу в двух местах —
 * в полосе при входе и в колокольчике, — а живёт оно в браузере, а не в
 * данных. Без оповещения колокольчик оставался с прежним ответом и предлагал
 * включить push, который только что включили.
 */
export const PUSH_CHANGED = "push-subscription-changed";

export function announcePushChange(): void {
  window.dispatchEvent(new CustomEvent(PUSH_CHANGED));
}

const announceChange = announcePushChange;

/** Умеет ли этот браузер push вообще. */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/** Текущее решение пользователя. До первого запроса — "default". */
export function pushPermission(): NotificationPermission | "unsupported" {
  return pushSupported() ? Notification.permission : "unsupported";
}

/**
 * iPhone и iPad умеют push только у приложения, добавленного на экран «Домой».
 * В обычной вкладке Safari подписаться нельзя — и запрашивать разрешение там
 * бессмысленно, поэтому вместо кнопки показываем, что нужно сделать.
 */
export function iosNeedsHomeScreen(): boolean {
  if (typeof window === "undefined") return false;
  const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!isIos) return false;
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return !standalone;
}

/**
 * Подключить это устройство. Запрос разрешения вызывается здесь же, поэтому
 * функцию нужно звать из обработчика нажатия: Safari не показывает окно
 * разрешения без действия пользователя.
 */
export async function enablePush(): Promise<PushResult> {
  if (!pushSupported()) {
    return { ok: false, reason: "Этот браузер не умеет push-уведомления.", blocked: true };
  }
  if (iosNeedsHomeScreen()) {
    return {
      ok: false,
      reason: "На iPhone уведомления работают только после «Поделиться» → «На экран „Домой“».",
      blocked: true,
    };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return {
      ok: false,
      reason: "Браузер не дал разрешение. Включите уведомления в настройках сайта и повторите.",
      blocked: permission === "denied",
    };
  }
  return registerSubscription();
}

/**
 * Создать (или обновить) подписку и передать её на сервер. Разрешение к этому
 * моменту уже должно быть выдано.
 */
async function registerSubscription(): Promise<PushResult> {
  const key = await getVapidPublicKey();
  if (!key) {
    return { ok: false, reason: "На сервере не заданы ключи push. Проверьте /api/health.", blocked: true };
  }

  await navigator.serviceWorker.register("/sw.js").catch(() => {});
  const reg = await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();

  /**
   * Если ключ на сервере сменился, старая подписка становится недействительной
   * и служба push отвечает отказом 403 на каждое уведомление. Молча этого не
   * видно, поэтому сверяем ключ подписки с текущим и переподписываемся.
   */
  if (sub) {
    const usedKey = sub.options.applicationServerKey;
    if (!usedKey || bufferToBase64Url(usedKey) !== key) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
  }

  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
    });
  }

  await subscribePush(JSON.parse(JSON.stringify(sub)), navigator.userAgent);
  announceChange();
  return { ok: true, endpoint: sub.endpoint };
}

/**
 * Подключено ли это устройство на самом деле. Одного разрешения браузера мало:
 * подписка могла быть отозвана или выдана под прежний ключ сервера — тогда
 * уведомления не приходят, хотя разрешение на месте.
 */
export async function pushActive(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return false;
    const key = await getVapidPublicKey();
    const used = sub.options.applicationServerKey;
    return Boolean(key && used && bufferToBase64Url(used) === key);
  } catch {
    return false;
  }
}

/**
 * Тихая проверка при каждом входе: разрешение уже есть — значит устройство
 * должно быть в списке. Ничего не спрашивает и не показывает.
 *
 * Нужна не только для новых устройств. Браузер может отозвать подписку сам
 * (очистка данных, долгое отсутствие), и тогда сотрудник считает, что
 * уведомления подключены, а на деле их нет.
 */
export async function syncPushSilently(): Promise<PushResult | null> {
  if (!pushSupported() || Notification.permission !== "granted") return null;
  try {
    return await registerSubscription();
  } catch {
    return null;
  }
}
