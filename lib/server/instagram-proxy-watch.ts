import { isInstagramEnabled } from "@/lib/integrations/instagram/config";
import { instagramCompanies } from "@/lib/integrations/instagram/credentials";
import {
  INITIAL_WATCH,
  checkProxy,
  nextWatch,
  reasonOf,
  type ProxyCheck,
  type WatchState,
} from "@/lib/integrations/instagram/proxy-health";
import { inboxRecipients, notifyStaff } from "@/lib/server/notify";

/**
 * Проверка прокси Instagram по расписанию — раз в пять минут.
 *
 * Состояние в globalThis по той же причине, что у планировщика: модуль Next
 * загружает дважды, и у каждой копии были бы свои счётчики. После перезапуска
 * процесса состояние начинается заново: если прокси всё ещё лежит,
 * администраторы узнают об этом повторно — это лучше, чем не узнать.
 */
const shared = ((globalThis as Record<string, unknown>).__clinicIgProxyWatch ??=
  {
    state: INITIAL_WATCH,
    running: false,
  }) as { state: WatchState; running: boolean };

export const PROXY_CHECK_INTERVAL_MIN = 5;

/** Последний результат — для /api/health и «Настройки → Интеграции». */
export function proxyWatchState(): WatchState {
  return shared.state;
}

export async function runProxyWatch(): Promise<ProxyCheck | null> {
  // Интеграция выключена — ни одного обращения к Meta, как и обещано в config.ts.
  if (!isInstagramEnabled() || shared.running) return null;
  shared.running = true;
  try {
    const check = await checkProxy();
    if (!check.ok) {
      console.error(
        "[instagram-proxy] проверка не прошла:",
        [
          check.outbound && `исходящие — ${check.outbound}`,
          check.inbound && `входящие — ${check.inbound}`,
        ]
          .filter(Boolean)
          .join("; "),
      );
    }
    const { state, alert } = nextWatch(shared.state, check);
    shared.state = state;
    if (alert) {
      console.error(
        `[instagram-proxy] ${alert === "down" ? "НЕДОСТУПЕН — уведомляем" : "снова работает"}`,
      );
      await notifyAll(alert, check).catch((e) =>
        console.error(
          "[instagram-proxy] уведомление не ушло:",
          (e as Error)?.message ?? e,
        ),
      );
    }
    return check;
  } finally {
    shared.running = false;
  }
}

async function notifyAll(
  alert: "down" | "recovered",
  check: ProxyCheck,
): Promise<void> {
  const reason = reasonOf(check);
  const title =
    alert === "down"
      ? "Instagram: связь потеряна"
      : "Instagram: связь восстановлена";
  /**
   * Главное в тексте — следствие, а не техника: без него пустой инбокс
   * Instagram читается как «сегодня никто не писал».
   */
  const body =
    alert === "down"
      ? `Прокси Instagram не отвечает. Сообщения пациентов из Instagram сейчас не приходят, ` +
        `ответы не уходят — пустой Instagram в «Диалогах» не значит, что никто не писал. ${reason}`
      : "Прокси Instagram снова отвечает: сообщения идут. Проверьте Instagram в самом приложении — " +
        "написанное за время сбоя Meta могла не передать.";

  for (const companyId of await instagramCompanies()) {
    await notifyStaff({
      companyId,
      recipientIds: await inboxRecipients(companyId),
      kind: "SYSTEM",
      title,
      body: body.slice(0, 500),
      url: "/settings/integrations",
    });
  }
}
