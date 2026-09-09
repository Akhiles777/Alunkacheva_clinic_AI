/**
 * Очередь отметок «диалог прочитан».
 *
 * Отметка прочтения — единственное действие в инбоксе, которое человек не
 * совершает: он просто открыл переписку. Поэтому её неудача не должна ни о чём
 * его просить. Раньше просила: сбой сети или перезапуск приложения на сервере
 * (а он в этой системе бывает) отвечал полосой «Не удалось отметить диалог
 * прочитанным. Изменение не записано — повторите действие», хотя повторять
 * человеку нечего — он уже открыл диалог, и второй раз открывать его незачем.
 *
 * Теперь отметка живёт в очереди: экран гасит точку сразу, запись повторяется
 * сама — быстрыми попытками, потом редкими, на каждом круге опроса списка и
 * при возвращении в приложение. Пока запись не легла, экран держит свою
 * пометку: список тянется каждые шесть секунд, и без этого точка гасла на
 * мгновение и загоралась снова.
 *
 * **Новое сообщение отменяет отметку.** Сервер ставит `staffReadAt` временем
 * СВОЕГО запроса, поэтому повтор, доехавший после нового сообщения от
 * пациента, погасил бы и его — непрочитанное сообщение исчезло бы из списка,
 * так его никто и не увидев. Лучше зажечь точку заново.
 */

export interface ReadMark {
  /** Последнее сообщение на момент открытия: по нему видно, пришло ли новое. */
  lastMessageId: string | null;
  /** Сколько раз запись уже не удалась. */
  tries: number;
  sending: boolean;
  /** Раньше этого времени не повторяем. */
  nextTryAt: number;
}

export interface ReadMarksOptions {
  send: (dialogId: string) => Promise<unknown>;
  /** Каждая неудача — в консоль и сторожу старой сборки, но не человеку. */
  onFailed?: (dialogId: string, reason: unknown, tries: number) => void;
  now?: () => number;
  delay?: (fn: () => void, ms: number) => void;
}

/** Быстрые повторы: сеть моргнула, приложение перезапускалось. */
export const RETRY_DELAYS = [800, 3000, 12_000];
/** Дальше — редкие: держим очередь, но не долбим сервер. */
export const SLOW_RETRY_MS = 60_000;

export interface ReadMarks {
  mark(dialogId: string, lastMessageId: string | null): void;
  /** Повторить всё, чему пришёл срок. Зовётся с круга опроса и при возврате. */
  flush(): void;
  /**
   * Держать ли диалог прочитанным вопреки серверу. Заодно снимает отметку,
   * если у диалога появилось новое сообщение.
   */
  staysRead(dialogId: string, lastMessageId: string | null): boolean;
  pending(): number;
}

export function createReadMarks(opts: ReadMarksOptions): ReadMarks {
  const marks = new Map<string, ReadMark>();
  const now = opts.now ?? (() => Date.now());
  const delay =
    opts.delay ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms);
    });

  function attempt(dialogId: string) {
    const m = marks.get(dialogId);
    if (!m || m.sending) return;
    m.sending = true;
    void Promise.resolve()
      .then(() => opts.send(dialogId))
      .then(() => {
        marks.delete(dialogId);
      })
      .catch((reason: unknown) => {
        const cur = marks.get(dialogId);
        if (!cur) return;
        cur.sending = false;
        cur.tries += 1;
        opts.onFailed?.(dialogId, reason, cur.tries);
        const wait = RETRY_DELAYS[cur.tries - 1];
        if (wait === undefined) {
          cur.nextTryAt = now() + SLOW_RETRY_MS;
          return;
        }
        cur.nextTryAt = now() + wait;
        delay(() => attempt(dialogId), wait);
      });
  }

  return {
    mark(dialogId, lastMessageId) {
      const existing = marks.get(dialogId);
      if (existing) {
        existing.lastMessageId = lastMessageId;
        existing.tries = 0;
        existing.nextTryAt = now();
      } else {
        marks.set(dialogId, { lastMessageId, tries: 0, sending: false, nextTryAt: now() });
      }
      attempt(dialogId);
    },
    flush() {
      for (const [id, m] of marks) if (!m.sending && m.nextTryAt <= now()) attempt(id);
    },
    staysRead(dialogId, lastMessageId) {
      const m = marks.get(dialogId);
      if (!m) return false;
      if (m.lastMessageId !== lastMessageId) {
        marks.delete(dialogId);
        return false;
      }
      return true;
    },
    pending() {
      return marks.size;
    },
  };
}
