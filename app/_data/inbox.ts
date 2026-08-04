/**
 * Инбокс: справочники и фильтры. Сами диалоги живут в общем сторе (store.ts),
 * поэтому отправка и начало диалога сразу отражаются везде.
 */
import type { Dialog, DialogChannel, DialogStatus } from "./store";

export const DIALOG_FILTERS = [
  { id: "need", label: "Нужен ответ" },
  { id: "escalated", label: "Эскалации" },
  { id: "drafts", label: "Черновики агента" },
  { id: "all", label: "Все" },
  { id: "closed", label: "Закрытые" },
] as const;

export function dialogMatchesFilter(d: Dialog, filter: string): boolean {
  switch (filter) {
    case "need":
      return d.unread && d.status !== "closed";
    case "escalated":
      return d.status === "escalated";
    case "drafts":
      return Boolean(d.agentDraft);
    case "closed":
      return d.status === "closed";
    default:
      return true;
  }
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
