/**
 * Инбокс: порядок списка и справочники подписей. Сами диалоги живут в общем
 * сторе (store.ts), поэтому отправка и начало диалога сразу отражаются везде.
 *
 * Фильтров-вкладок здесь больше нет. Их было пять, и каждый требовал решения
 * ДО работы: сначала выбери вкладку, потом смотри, кому отвечать. Порядок
 * отвечает на тот же вопрос лучше — сверху тот, кто ждёт дольше всех.
 */
import type { Dialog, DialogChannel, DialogStatus } from "./store";
import { compareQueue } from "@/lib/inbox/waiting";

/**
 * Порядок списка: сначала те, кто ждёт дольше.
 *
 * Правило и его тесты — в `lib/inbox/waiting.ts`; здесь только перевод строки
 * диалога в то, что оно спрашивает. Время последнего сообщения приходит с
 * сервера подписью («14:20»), поэтому запасным порядком служит позиция в
 * исходном списке: он уже отсортирован сервером по времени.
 */
export function sortDialogs(dialogs: Dialog[]): Dialog[] {
  return dialogs
    .map((d, i) => ({ d, i }))
    .sort((a, b) =>
      compareQueue(
        {
          waitingSince: a.d.waitingSince ?? null,
          at: -a.i,
          // Назревшее напоминание поднимает диалог так же, как эскалация:
          // «вернуться через два дня» бесполезно, если через два дня строка
          // лежит там же, где лежала.
          escalated: a.d.status === "escalated" || Boolean(a.d.reminder),
        },
        {
          waitingSince: b.d.waitingSince ?? null,
          at: -b.i,
          escalated: b.d.status === "escalated" || Boolean(b.d.reminder),
        },
      ),
    )
    .map((x) => x.d);
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
