/**
 * Инбокс: справочники и фильтры. Сами диалоги живут в общем сторе (store.ts),
 * поэтому отправка и начало диалога сразу отражаются везде.
 */
import type { Dialog, DialogChannel, DialogStatus } from "./store";

/**
 * Три фильтра вместо пяти. «Черновики агента» всегда были пусты — suggest-режим
 * не реализован; «Закрытые» администратору в работе не нужны и прятались за
 * лишним кликом. Осталось то, по чему действительно работают: кому ответить,
 * что горит, и полный список.
 */
export const DIALOG_FILTERS = [
  { id: "need", label: "Нужен ответ" },
  { id: "escalated", label: "Срочные" },
  { id: "all", label: "Все" },
] as const;

export function dialogMatchesFilter(d: Dialog, filter: string): boolean {
  switch (filter) {
    case "need":
      return d.unread && d.status !== "closed";
    case "escalated":
      return d.status === "escalated";
    default:
      // «Все» — без закрытых: они уводят внимание, а вернуться к ним можно
      // через карточку пациента.
      return d.status !== "closed";
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
