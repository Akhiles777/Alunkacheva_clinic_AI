/* Service worker «Меры»: push-уведомления и заглушка офлайна.
 *
 * Страницы приложения намеренно НЕ кэшируются. Раньше воркер клал ответ любой
 * навигации в кэш под ключом "/" — то есть авторизованный HTML с карточками
 * пациентов оседал в памяти устройства и потом показывался в том числе после
 * выхода из системы. Для медицинских данных это недопустимо (§7), поэтому
 * навигация всегда идёт в сеть, а офлайн получает статическую заглушку.
 */
const CACHE = "mera-v2";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE_URL, "/icon.svg"])));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
});

// Пуш-уведомления. Тело сообщения в уведомление не кладём — только повод и
// ссылка: текст переписки с пациентом не должен всплывать на экране блокировки.
self.addEventListener("push", (event) => {
  let data = { title: "Мера", body: "Новое уведомление", url: "/" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
