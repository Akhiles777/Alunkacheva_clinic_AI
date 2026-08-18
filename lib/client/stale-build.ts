/**
 * Признак того, что вкладка работает на старой сборке.
 *
 * Платформа установлена как приложение и неделями не закрывается. После
 * обновления открытая копия остаётся на прежнем коде: серверные действия
 * опознаются по идентификатору, а он у новой сборки другой. Любое действие
 * отвечает «Server Action … was not found», и снаружи это выглядит как
 * сломанная платформа — сообщение не уходит, запись не создаётся.
 *
 * Раньше это ловилось только по НЕобработанным ошибкам. Но чтения данных
 * обёрнуты в catch — они и должны быть обёрнуты, — поэтому вкладка после
 * обновления просто переставала получать свежие данные, молча. Теперь любое
 * место, поймавшее ошибку, может сказать об этом сторожу одной строкой.
 */

export const STALE_BUILD_EVENT = "clinic:stale-build";

export function isStaleBuildError(reason: unknown): boolean {
  const text =
    typeof reason === "string"
      ? reason
      : reason instanceof Error
        ? `${reason.message} ${reason.name}`
        : "";
  return /Server Action .* was not found|Failed to find Server Action/i.test(text);
}

/**
 * Сообщить сторожу, что ошибка похожа на старую сборку.
 *
 * Ничего не делает, если ошибка о другом: перезагружать вкладку из-за
 * случайного сбоя сети нельзя — человек потеряет то, что печатал.
 */
export function reportMaybeStale(reason: unknown): void {
  if (typeof window === "undefined") return;
  if (!isStaleBuildError(reason)) return;
  window.dispatchEvent(new CustomEvent(STALE_BUILD_EVENT));
}
