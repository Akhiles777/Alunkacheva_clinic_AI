import { STALE_MIN, STALE_REASON } from "./queue-rule";
import type { DeliveryStage } from "@/lib/integrations/delivery";

/**
 * Сообщение, которое ушло с опозданием, — удалить у пациента.
 *
 * Последний рубеж после очистки очереди (`whatsapp-queue-watch.ts`): очередь
 * чистится раз в минуту, а провайдер, которого починили, отправляет всё
 * накопленное сразу. Если сообщение успело уйти, о его судьбе говорит только
 * статус «sent» — его время и сравниваем со временем ответа.
 *
 * Решение заказчика (12 октября): не ушло за пять минут или человек уже
 * ответил — не отправлять. Удалить у пациента — ближайшее к «не отправлять»,
 * что можно сделать, когда сообщение уже ушло.
 *
 * Трогаем только ответы агента и сообщения, которые мы сами пометили снятыми.
 * Опоздавшее сообщение администратора удалять молча нельзя: он писал его
 * осознанно и видит его у себя отправленным.
 */

/** Начало причины у опоздавших: по нему следующие статусы сообщение не «воскрешают». */
export const LATE_PREFIX = "ушло с опозданием";
export const LATE_REASON = `${LATE_PREFIX} — удалено у пациента`;
export const lateKeptReason = (error: string) =>
  `${LATE_PREFIX} — удалить у пациента не удалось: ${error}`.slice(0, 300);

export interface LateFacts {
  authorType: string;
  createdAt: Date;
  failureReason: string | null;
  /** Когда провайдер отправил (время из статуса). Неизвестно — по опозданию не судим. */
  sentAt: Date | null;
  /** После этого сообщения и до его отправки в переписке уже писали. */
  repliedBeforeSent: boolean;
}

export function shouldRetract(stage: DeliveryStage, m: LateFacts): boolean {
  if (stage === "failed") return false;
  // Мы уже сказали администратору «снято» — экран и телефон пациента обязаны совпасть.
  if (m.failureReason === STALE_REASON) return true;
  if (m.authorType !== "BOT" || stage !== "sent" || !m.sentAt) return false;
  const lag = m.sentAt.getTime() - m.createdAt.getTime();
  /**
   * Задержка вебхука сюда не входит: время берём из самого статуса. Без него
   * («sentAt» неизвестен) не удаляем — вовремя ушедшее сообщение, о котором
   * провайдер сообщил поздно, удалять нельзя.
   */
  return lag >= STALE_MIN * 60_000 || (lag >= 60_000 && m.repliedBeforeSent);
}
