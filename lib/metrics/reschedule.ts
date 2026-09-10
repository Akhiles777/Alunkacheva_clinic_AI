/**
 * Переносы записей.
 *
 * YCLIENTS не сообщает о переносе ничего: он показывает запись в её текущем
 * виде, и прошлого времени там нет. Значит перенос можно только ЗАМЕТИТЬ в
 * момент выгрузки — задним числом его не восстановить ни по каким полям.
 * Отсюда главное свойство этой метрики: она начинает копиться со дня, когда
 * появилась, и врать о прошлом не должна.
 *
 * Переносят двумя способами, и они распознаются по-разному:
 *
 *   1. Правкой времени в самой записи. Номер тот же, время другое — это
 *      перенос без всяких допущений.
 *   2. Удалением и созданием заново. Старой записи в YCLIENTS больше нет,
 *      рядом появилась новая. Это уже вывод, а не факт: тот же человек мог
 *      отменить визит и через день записаться заново по другому поводу.
 *
 * Второй случай помечается отдельно и на экране подписан иначе — «похоже на
 * перенос». Догадка не подаётся как факт (§9).
 */

export interface VanishedVisit {
  appointmentId: string;
  patientId: string | null;
  startAt: Date;
}

export interface MoveCandidate {
  appointmentId: string;
  patientId: string | null;
  startAt: Date;
  /** Когда запись завели в YCLIENTS. */
  createdAt: Date;
}

export interface DerivedMove {
  /** Запись в её новом виде — на неё и ведёт ссылка. */
  appointmentId: string;
  patientId: string | null;
  fromStartAt: Date;
  toStartAt: Date;
}

/**
 * Насколько свежей должна быть новая запись, чтобы считать её тем же визитом.
 *
 * Трое суток — верхняя граница здравого смысла: перенос делают сразу, а
 * запись, заведённая через неделю, это уже новое обращение, и называть её
 * переносом значит приписывать клинике чужую историю.
 */
export const PAIR_WINDOW_DAYS = 3;

/**
 * Сопоставить исчезнувшие записи с новыми.
 *
 * Правила намеренно узкие: лучше не заметить перенос, чем назвать переносом
 * отдельную запись. Каждое условие закрывает свой способ ошибиться.
 */
export function pairMoves(
  vanished: VanishedVisit[],
  candidates: MoveCandidate[],
  now: Date,
): DerivedMove[] {
  const windowMs = PAIR_WINDOW_DAYS * 24 * 3600 * 1000;
  const out: DerivedMove[] = [];
  const used = new Set<string>();

  for (const gone of vanished) {
    // Без пациента пара не строится: связать записи больше не по чему.
    if (!gone.patientId) continue;
    /**
     * Исчезнувший ПРОШЕДШИЙ приём — не перенос.
     *
     * Запись, время которой давно прошло, из YCLIENTS убирают по другим
     * причинам: чистят ошибочные, сводят дубли. Переносят то, что ещё
     * впереди.
     */
    if (gone.startAt <= now) continue;

    const pair = candidates
      .filter(
        (c) =>
          c.patientId === gone.patientId &&
          !used.has(c.appointmentId) &&
          c.appointmentId !== gone.appointmentId &&
          // Новое время должно отличаться — иначе это та же запись, а не перенос.
          c.startAt.getTime() !== gone.startAt.getTime() &&
          now.getTime() - c.createdAt.getTime() <= windowMs &&
          c.createdAt <= now,
      )
      /**
       * Из нескольких подходящих берём самую свежую по созданию: перенос —
       * последнее решение администратора, а не первое.
       */
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

    if (!pair) continue;
    used.add(pair.appointmentId);
    out.push({
      appointmentId: pair.appointmentId,
      patientId: gone.patientId,
      fromStartAt: gone.startAt,
      toStartAt: pair.startAt,
    });
  }

  return out;
}

/**
 * Перенос это или нет, когда время изменилось у той же записи.
 *
 * Отдельная функция ради одного условия, которое легко забыть: выгрузка
 * трогает `startAt` и тогда, когда ничего не переносили, — например при
 * первом заполнении поля. Разница меньше минуты переносом не считается:
 * секунды приезжают из округлений на стороне провайдера.
 */
export const MIN_MOVE_MS = 60_000;

export function isRealMove(from: Date, to: Date): boolean {
  return Math.abs(to.getTime() - from.getTime()) >= MIN_MOVE_MS;
}
