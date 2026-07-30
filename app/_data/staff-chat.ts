"use client";

import { useSyncExternalStore } from "react";

/**
 * Внутренний чат сотрудников. Живёт в клиентском сторе (демо). Позволяет
 * обмениваться сообщениями и прикреплять карточку пациента или курс в удобном
 * формате — врач переслал коллеге, кого готовить к приёму.
 *
 * Персональные данные тут остаются внутри периметра клиники (§7): это внутренний
 * инструмент, наружу ничего не уходит.
 */
export interface ChatAttachment {
  kind: "patient" | "course";
  label: string;
  detail: string;
  patientId?: string;
}
export interface StaffMessage {
  id: string;
  from: string;
  text: string;
  at: string;
  attachment?: ChatAttachment;
}

let seq = 0;
const uid = () => `sm-${Date.now()}-${seq++}`;
function nowLabel(): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date());
}

let messages: StaffMessage[] = [
  { id: "s1", from: "Соколова Е.", text: "Гринберг сегодня на 6-й капельнице курса, всё по плану.", at: "09:40" },
  { id: "s2", from: "Левин А.", text: "Принял. Кто ведёт Седых? Он выпал из курса, надо вернуть.", at: "09:52" },
];
const listeners = new Set<() => void>();

function commit(next: StaffMessage[]) {
  messages = next;
  listeners.forEach((l) => l());
}

export function sendStaffMessage(from: string, text: string, attachment?: ChatAttachment) {
  const t = text.trim();
  if (!t && !attachment) return;
  commit([...messages, { id: uid(), from, text: t, at: nowLabel(), attachment }]);
}

export function useStaffChat(): StaffMessage[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => messages,
    () => messages,
  );
}
