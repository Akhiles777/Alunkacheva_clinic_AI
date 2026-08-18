"use client";

import { useEffect, useState } from "react";
import { STALE_BUILD_EVENT, isStaleBuildError } from "@/lib/client/stale-build";

/**
 * Перезагрузка вкладки после выхода новой версии.
 *
 * Платформа установлена как приложение и неделями не закрывается. После
 * очередного обновления открытая копия остаётся на старом коде, и любое
 * действие на сервере отвечает «Server Action … was not found on the server»:
 * серверные действия опознаются по идентификатору, а он у новой сборки другой.
 *
 * Внешне это выглядит хуже, чем есть: сообщение в чат не отправляется, запись
 * не создаётся, уведомление не появляется — и кажется, что сломана вся
 * платформа. Поэтому такую ошибку распознаём и обновляем страницу сами.
 *
 * Перезагружаемся один раз за сессию вкладки: если после обновления ошибка
 * повторится, зацикливаться нельзя — лучше показать честное сообщение.
 */
const RELOADED_KEY = "stale-build-reloaded";

export function StaleBuildGuard() {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    function handle(reason: unknown) {
      if (!isStaleBuildError(reason)) return;
      if (sessionStorage.getItem(RELOADED_KEY) === "1") {
        setStuck(true);
        return;
      }
      sessionStorage.setItem(RELOADED_KEY, "1");
      // Обновление приложения могло принести и новый service worker —
      // снимаем его с регистрации, иначе старая версия останется активной.
      void navigator.serviceWorker
        ?.getRegistrations()
        .then((rs) => Promise.all(rs.map((r) => r.update())))
        .catch(() => {})
        .finally(() => location.reload());
    }

    const onRejection = (e: PromiseRejectionEvent) => handle(e.reason);
    const onError = (e: ErrorEvent) => handle(e.error ?? e.message);
    /**
     * Ошибка, которую уже поймали в своём catch, до сюда не долетает: чтения
     * данных обёрнуты намеренно. Пусть они говорят о ней сами — иначе вкладка
     * после обновления молча перестаёт получать свежие данные.
     */
    const onReported = () => handle("Server Action was not found on the server");
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    window.addEventListener(STALE_BUILD_EVENT, onReported);

    // Успешная работа означает, что версия совпала: снимаем отметку, чтобы
    // следующее обновление снова могло перезагрузить вкладку.
    const t = setTimeout(() => sessionStorage.removeItem(RELOADED_KEY), 15_000);

    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
      window.removeEventListener(STALE_BUILD_EVENT, onReported);
      clearTimeout(t);
    };
  }, []);

  if (!stuck) return null;

  return (
    <div
      role="alert"
      className="border-border bg-surface fixed inset-x-3 bottom-3 z-50 mx-auto max-w-lg rounded-xl border p-3 shadow-lg md:inset-x-auto md:right-4 md:bottom-4"
    >
      <p className="text-sm font-medium">Вышла новая версия платформы</p>
      <p className="text-text-muted mt-0.5 text-xs">
        Закройте приложение полностью и откройте заново — иначе действия не будут сохраняться.
      </p>
      <button
        type="button"
        onClick={() => location.reload()}
        className="bg-accent text-accent-contrast mt-2 rounded-md px-3 py-1.5 text-sm"
      >
        Обновить сейчас
      </button>
    </div>
  );
}
