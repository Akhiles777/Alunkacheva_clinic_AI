"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { noteVisit } from "./visit-actions";

/**
 * Отметка о том, какой экран открыли.
 *
 * Ничего не рисует. Стоит один раз в общей раскладке и срабатывает при смене
 * адреса — то есть ровно тогда, когда человек куда-то перешёл.
 *
 * Почему на стороне экрана, а не на сервере: серверная раскладка при переходах
 * внутри приложения заново не выполняется, и половина переходов прошла бы
 * мимо. А главное — отсюда запись НЕ ЗАДЕРЖИВАЕТ переход: вызов уходит без
 * ожидания ответа, и даже если он не дойдёт, человек этого не заметит.
 *
 * Повторы отсекаются здесь же. Один и тот же экран, открытый десять раз за
 * пять минут, пишется один раз: без этого журнал превращался бы в ленту
 * переходов туда-обратно, в которой не разглядеть работу, а база получала бы
 * поток записей ни о чём.
 */

/** Сколько молчим про уже отмеченный экран. */
const QUIET_MS = 5 * 60 * 1000;

/**
 * Отметка об открытой переписке.
 *
 * Живёт здесь, а не в инбоксе, чтобы правило отсечения повторов было ОДНО на
 * обе дороги: выбор диалога адрес не меняет (инбокс чистит его сразу, чтобы
 * перезагрузка не возвращала к закрытому разговору), и следящий за адресом
 * компонент такого перехода не видит.
 *
 * Как и всё здесь — без ожидания ответа: открытие переписки не должно ждать
 * записи в базу.
 */
const seenDialogs = new Map<string, number>();

export function noteDialogOpen(dialogId: string): void {
  const now = Date.now();
  if (now - (seenDialogs.get(dialogId) ?? 0) < QUIET_MS) return;
  seenDialogs.set(dialogId, now);
  if (seenDialogs.size > 300) {
    for (const [id, at] of seenDialogs) if (now - at >= QUIET_MS) seenDialogs.delete(id);
  }
  void noteVisit("/inbox", dialogId).catch(() => {});
}

export function VisitLogger() {
  const pathname = usePathname();
  const params = useSearchParams();
  /** Что уже отметили в этой вкладке: ключ → когда. */
  const seen = useRef<Map<string, number>>(new Map());

  const dialogId = params.get("d");

  useEffect(() => {
    if (!pathname) return;
    /**
     * Раздел учёта себя не отмечает.
     *
     * Иначе владелец, открыв его, первым делом видел бы собственные открытия
     * этого же экрана — журнал о самом журнале. Ссылок на раздел нет нигде, и
     * в списке действий ему тоже делать нечего.
     */
    if (pathname.startsWith("/sistem")) return;

    const key = dialogId ? `d:${dialogId}` : `p:${pathname}`;
    const now = Date.now();
    const last = seen.current.get(key) ?? 0;
    if (now - last < QUIET_MS) return;
    seen.current.set(key, now);

    /**
     * Карта вкладки не должна расти бесконечно: администратор держит платформу
     * открытой неделями и обходит сотни диалогов.
     */
    if (seen.current.size > 300) {
      for (const [k, at] of seen.current) {
        if (now - at >= QUIET_MS) seen.current.delete(k);
      }
    }

    // Без await: переход между экранами ждать запись не должен.
    void noteVisit(pathname, dialogId).catch(() => {});
  }, [pathname, dialogId]);

  return null;
}
