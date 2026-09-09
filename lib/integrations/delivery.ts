import type { MessageStatus } from "@/generated/prisma/enums";

/**
 * Что провайдер сказал о судьбе нашего сообщения.
 *
 * Статусы приходили вебхуком и выбрасывались: обработчик отвечал «ok» и не
 * записывал ничего. Из-за этого в переписке каждое своё сообщение выглядело
 * одинаково — отправлено, — и «не доставлено» было не отличить от
 * «прочитано». Администратор ждал ответа на сообщение, которое до пациента
 * не дошло.
 *
 * Правило простое и одно: состояние только вперёд. Провайдер присылает
 * события не по порядку (read может опередить delivered), и запись «назад»
 * означала бы, что прочитанное сообщение снова стало доставленным.
 */
export type DeliveryStage = "sent" | "delivered" | "read" | "failed";

const RANK: Record<DeliveryStage, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

/** Слова Green API → наши состояния. */
export function stageOf(raw: string): DeliveryStage | null {
  const s = raw.trim().toLowerCase();
  if (s === "sent") return "sent";
  if (s === "delivered") return "delivered";
  if (s === "read") return "read";
  // noAccount — у номера нет WhatsApp; для дела это та же недоставка.
  if (s === "failed" || s === "noaccount" || s === "no_account") return "failed";
  return null;
}

export interface DeliveryPatch {
  status?: MessageStatus;
  deliveredAt?: Date;
  readAt?: Date;
  sentAt?: Date;
  failureReason?: string;
}

/**
 * Что записать в сообщение. Пусто — записывать нечего: это либо неизвестный
 * статус, либо шаг назад.
 */
export function deliveryPatch(
  current: { status: string; sentAt: Date | null; deliveredAt: Date | null; readAt: Date | null },
  stage: DeliveryStage,
  at: Date,
): DeliveryPatch | null {
  const now: DeliveryStage =
    current.status === "FAILED"
      ? "failed"
      : current.readAt
        ? "read"
        : current.deliveredAt
          ? "delivered"
          : current.sentAt
            ? "sent"
            : "sent";

  /**
   * Недоставка после прочтения — не бывает; а вот прочтение после нашей
   * пометки FAILED бывает: сообщение всё-таки ушло, а мы не дождались ответа
   * провайдера. Тогда правда за провайдером.
   */
  if (stage !== "failed" && current.status === "FAILED") {
    return stage === "read"
      ? { status: "SENT", sentAt: current.sentAt ?? at, deliveredAt: current.deliveredAt ?? at, readAt: at }
      : stage === "delivered"
        ? { status: "SENT", sentAt: current.sentAt ?? at, deliveredAt: at }
        : { status: "SENT", sentAt: current.sentAt ?? at };
  }

  if (RANK[stage] <= RANK[now] && !(stage === "failed" && now !== "failed")) return null;

  if (stage === "failed") {
    return { status: "FAILED", failureReason: "провайдер сообщил, что сообщение не доставлено" };
  }
  if (stage === "read") {
    return {
      status: "SENT",
      sentAt: current.sentAt ?? at,
      deliveredAt: current.deliveredAt ?? at,
      readAt: at,
    };
  }
  if (stage === "delivered") {
    return { status: "SENT", sentAt: current.sentAt ?? at, deliveredAt: at };
  }
  return { status: "SENT", sentAt: at };
}
