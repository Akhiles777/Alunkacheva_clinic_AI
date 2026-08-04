"use client";

import { useEffect, useState } from "react";
import {
  enablePush,
  iosNeedsHomeScreen,
  pushPermission,
  syncPushSilently,
} from "./push-subscribe";

/**
 * Подключение уведомлений при входе.
 *
 * Раньше устройство добавлялось только вручную в разделе настроек, куда
 * сотрудники не заходят. В итоге у администратора и врача не было ни одной
 * подписки, эскалации им уходили в пустоту, и выглядело это как поломка push.
 *
 * Поведение:
 *  · разрешение уже выдано — тихо убеждаемся, что подписка на месте и
 *    актуальна; ничего не показываем;
 *  · разрешение не спрашивали — один раз показываем полосу с объяснением,
 *    зачем это нужно. Запрос браузера вызывается по нажатию: Safari не
 *    показывает окно без действия пользователя, а незапрошенное окно на
 *    открытии страницы легко закрывают не глядя, и второго шанса уже не будет;
 *  · в разрешении отказано — молчим. Повторный запрос браузер всё равно не
 *    покажет, а мигать бесполезной полосой при каждом входе нельзя.
 */
const DISMISS_KEY = "push-gate-dismissed";

type Stage = "hidden" | "ask" | "ios" | "done" | "failed";

export function PushGate() {
  // На сервере не рендерим ничего: решение зависит от состояния браузера.
  const [stage, setStage] = useState<Stage>("hidden");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;

    const permission = pushPermission();
    if (permission === "granted") {
      // Тихо: подписка могла быть отозвана браузером или создана со старым
      // ключом — тогда она восстановится сама, без участия сотрудника.
      void syncPushSilently();
      return;
    }
    if (permission === "unsupported" || permission === "denied") return;
    if (localStorage.getItem(DISMISS_KEY) === "1") return;

    // Не в первую секунду после входа: даём странице отрисоваться, чтобы
    // полоса не выскакивала поверх ещё пустого экрана.
    const t = setTimeout(() => {
      if (alive) setStage(iosNeedsHomeScreen() ? "ios" : "ask");
    }, 1200);

    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    setStage("hidden");
  }

  async function allow() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await enablePush();
      if (res.ok) {
        setStage("done");
        setTimeout(() => setStage("hidden"), 4000);
      } else {
        setMessage(res.reason);
        setStage("failed");
        // Если браузер отказал насовсем, больше не предлагаем.
        if (res.blocked) localStorage.setItem(DISMISS_KEY, "1");
      }
    } catch {
      setMessage("Не удалось подключить уведомления. Попробуйте в настройках.");
      setStage("failed");
    } finally {
      setBusy(false);
    }
  }

  if (stage === "hidden") return null;

  return (
    <div
      role="status"
      className="border-border bg-surface fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-lg items-start gap-3 rounded-xl border p-3 shadow-lg md:inset-x-auto md:right-4 md:bottom-4"
    >
      <span aria-hidden className="mt-0.5 text-base leading-none">
        🔔
      </span>

      <div className="min-w-0 flex-1">
        {stage === "ask" ? (
          <>
            <p className="text-sm font-medium">Включить уведомления на этом устройстве?</p>
            <p className="text-text-muted mt-0.5 text-xs">
              Чтобы не пропустить сообщение пациента и вызов администратора, когда платформа
              закрыта.
            </p>
          </>
        ) : null}

        {stage === "ios" ? (
          <>
            <p className="text-sm font-medium">Уведомления на iPhone</p>
            <p className="text-text-muted mt-0.5 text-xs">
              Нажмите «Поделиться» → «На экран „Домой“» и откройте платформу с этого значка —
              после этого уведомления можно будет включить.
            </p>
          </>
        ) : null}

        {stage === "done" ? (
          <p className="text-sm">Уведомления включены — устройство добавлено в настройках.</p>
        ) : null}

        {stage === "failed" ? <p className="text-text-muted text-xs">{message}</p> : null}

        {stage === "ask" ? (
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={allow}
              disabled={busy}
              className="bg-accent text-accent-contrast rounded-md px-3 py-1.5 text-sm disabled:opacity-45"
            >
              {busy ? "Подключаем…" : "Включить"}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="text-text-subtle hover:text-text px-2 py-1.5 text-sm"
            >
              Не сейчас
            </button>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={dismiss}
        aria-label="Закрыть"
        className="text-text-subtle hover:text-text flex-none text-sm"
      >
        ✕
      </button>
    </div>
  );
}
