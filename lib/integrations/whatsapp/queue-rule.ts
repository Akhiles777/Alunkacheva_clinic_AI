/**
 * Когда очередь исходящих у Green API пора очистить.
 *
 * Решение заказчика, 12 октября: сообщение, которое не ушло за пять минут или
 * на которое человек уже ответил, отправлять нельзя. Green API так не умеет:
 * принятое сообщение лежит у него в очереди до суток и уходит сразу, как только
 * связь восстановится, — и пациент получает ответ на вопрос, который ему давно
 * закрыл администратор. Снять из очереди одно сообщение провайдер не позволяет,
 * только всю очередь целиком, и времени постановки у элементов нет.
 *
 * Поэтому чистим только ВСТАВШУЮ очередь: первое сообщение то же, что минуту
 * назад. Очередь, которая движется (рассылка на шестьдесят человек идёт с
 * интервалом и может занять минуты), не трогаем никогда. Вставшая очередь не
 * отправит и свежих сообщений, поэтому снять их вместе с устаревшими — не
 * потеря: они тоже стоят и тоже устареют.
 */

export const STALE_MIN = 5;

/** Причина «не ушло» у сообщений, снятых из очереди. */
export const STALE_REASON = `не ушло за ${STALE_MIN} минут — снято из очереди провайдера`;

export interface QueueWatch {
  /** Первое сообщение очереди на прошлой проверке. */
  headId: string | null;
  /** С какого момента оно первое (мс). */
  headSince: number | null;
}

export const EMPTY_WATCH: QueueWatch = { headId: null, headSince: null };

export interface QueuedFact {
  id: string;
  /** Наше сообщение с этим идентификатором — когда создано. Чужого (из телефона) не знаем. */
  ourCreatedAt?: Date | null;
  /** После нашего сообщения в той же переписке уже кто-то написал. */
  repliedAfter?: boolean;
}

export interface QueueVerdict {
  clear: boolean;
  reason: string | null;
  next: QueueWatch;
}

export function queueVerdict(prev: QueueWatch, queue: QueuedFact[], now: number): QueueVerdict {
  if (queue.length === 0) return { clear: false, reason: null, next: EMPTY_WATCH };

  const head = queue[0].id;
  const stuck = prev.headId === head && prev.headSince !== null;
  const headSince = stuck ? (prev.headSince as number) : now;
  const next: QueueWatch = { headId: head, headSince };
  if (!stuck) return { clear: false, reason: null, next };

  const staleMs = STALE_MIN * 60_000;
  const reason =
    now - headSince >= staleMs
      ? `очередь стоит дольше ${STALE_MIN} минут`
      : queue.some((q) => q.ourCreatedAt && now - q.ourCreatedAt.getTime() >= staleMs)
        ? `в очереди сообщение старше ${STALE_MIN} минут`
        : queue.some((q) => q.repliedAfter)
          ? "после сообщения в очереди уже ответили в переписке"
          : null;

  return reason ? { clear: true, reason, next: EMPTY_WATCH } : { clear: false, reason: null, next };
}
