/**
 * Инбокс: порядок списка и справочники подписей. Сами диалоги живут в общем
 * сторе (store.ts), поэтому отправка и начало диалога сразу отражаются везде.
 *
 * Фильтров-вкладок здесь нет и сортировки по ожиданию тоже: каждое такое
 * правило человек должен держать в голове, а список должен читаться без
 * правил.
 */
import type { Dialog, DialogChannel, DialogStatus } from "./store";

/**
 * Порядок списка — обычный: сверху последнее сообщение.
 *
 * Так его отдаёт сервер, и так устроен любой мессенджер. Перестановка по
 * времени ожидания требовала от человека держать в голове ещё одно правило,
 * а список должен читаться без правил.
 *
 * Единственное исключение — назревшее напоминание: администратор сам просил
 * вернуться к этому разговору в назначенный момент, и если строка останется
 * там же, где лежала, напоминание бесполезно.
 */
export function withRemindersFirst(dialogs: Dialog[]): Dialog[] {
  const due = dialogs.filter((d) => d.reminder);
  if (due.length === 0) return dialogs;
  return [...due, ...dialogs.filter((d) => !d.reminder)];
}

export const DIALOG_STATUS_LABEL: Record<DialogStatus, string> = {
  bot: "ведёт агент",
  escalated: "нужен человек",
  human: "ведёт человек",
  closed: "закрыт",
};

export const CHANNEL_LABEL: Record<DialogChannel, string> = {
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
};
