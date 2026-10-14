import { cantCome, wantsReschedule } from "@/lib/agent/triggers";

/**
 * Что пациент хочет с записью — по его неотвеченным сообщениям.
 *
 * Отмена и перенос — срочное в списке «Диалогов»: освободившееся время можно
 * отдать другому, только если узнать о нём сразу, а не к вечеру. Правила те же,
 * что у агента (`cantCome`, `wantsReschedule`), чтобы список и агент не
 * расходились в том, что считать отменой. Смотрим только реплики после нашего
 * последнего ответа: вчерашняя отмена, на которую уже ответили, не срочная.
 */
export type ScheduleChange = "cancel" | "move" | null;

export function scheduleChangeOf(messages: { direction: "IN" | "OUT"; body: string }[]): ScheduleChange {
  const trailing: string[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].direction === "IN"; i--) trailing.push(messages[i].body);
  if (trailing.some((t) => cantCome(t))) return "cancel";
  if (trailing.some((t) => wantsReschedule(t))) return "move";
  return null;
}
