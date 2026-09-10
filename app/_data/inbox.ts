/**
 * Инбокс: справочники и фильтры. Сами диалоги живут в общем сторе (store.ts),
 * поэтому отправка и начало диалога сразу отражаются везде.
 */
import type { Dialog, DialogChannel, DialogStatus } from "./store";
import { compareQueue } from "@/lib/inbox/waiting";

/**
 * Фильтры списка.
 *
 * Было три: «нужен ответ», «срочные», «все». Двух не хватало по разным
 * причинам. «Мои» — потому что в смену работают вдвоём и надо видеть свою
 * половину, а не чужую. «Закрытые» — потому что вернуться к закрытому
 * разговору можно было только через карточку пациента, то есть уйдя из
 * инбокса; ради этого администратор и открывал WhatsApp на телефоне.
 */
export const DIALOG_FILTERS = [
  { id: "need", label: "Нужен ответ" },
  { id: "escalated", label: "Срочные" },
  { id: "mine", label: "Мои" },
  { id: "all", label: "Все" },
  { id: "closed", label: "Закрытые" },
] as const;

export function dialogMatchesFilter(d: Dialog, filter: string): boolean {
  switch (filter) {
    case "need":
      return d.unread && d.status !== "closed";
    case "escalated":
      return d.status === "escalated";
    case "mine":
      // «Мои» — те, что ведёт человек: агентские сюда не идут, у них хозяина
      // нет. Отдельного назначения на сотрудника в переписке пока нет, и
      // придумывать его здесь нельзя — это была бы вторая правда о том, чей
      // разговор.
      return d.status === "human";
    case "closed":
      return d.status === "closed";
    default:
      // «Все» — без закрытых: они уводят внимание, и для них есть свой фильтр.
      return d.status !== "closed";
  }
}

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
