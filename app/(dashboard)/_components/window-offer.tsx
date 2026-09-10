"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/format";
import { windowCandidatesAction, windowStillFreeAction } from "./window-actions";
import type { WindowOffer } from "@/lib/server/window-candidates";

/**
 * Кого поставить в это окно.
 *
 * Свободные окна видны как факт, список «кому позвонить» — тоже; соединить их
 * администратор до сих пор мог только в голове. Здесь показаны те, кому это
 * окно ПОДХОДИТ: услуга влезает по времени, кабинет подходит, специалист
 * свободен, человеку есть куда написать и он сам в это время не занят.
 *
 * Кандидат, не прошедший хоть одну проверку, не показывается: позвонить и
 * получить «нет, не получится» хуже, чем не позвонить.
 */
export function WindowOfferPanel({
  roomId,
  startAtIso,
  durationMin,
  label,
  onClose,
}: {
  roomId: string;
  startAtIso: string;
  durationMin: number;
  /** Как называется окно на экране: «14:00 · кабинет 2 · 60 мин». */
  label: string;
  onClose: () => void;
}) {
  const [offer, setOffer] = useState<WindowOffer | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void windowCandidatesAction({ roomId, startAtIso, durationMin })
      .then((res) => alive && setOffer(res))
      .catch(() => alive && setNote("Не удалось собрать кандидатов"));
    return () => {
      alive = false;
    };
  }, [roomId, startAtIso, durationMin]);

  const skipped = offer
    ? Object.values(offer.skipped).reduce((s, n) => s + n, 0)
    : 0;

  return (
    <div
      className="overlay-scrim fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="border-border bg-surface max-h-[76vh] w-full max-w-[560px] overflow-auto rounded-xl border p-5"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Кого позвать в окно"
      >
        <div className="mb-1 flex flex-wrap items-baseline gap-3">
          <h2 className="text-md font-medium">Кого позвать</h2>
          <span className="text-text-subtle text-2xs">{label}</span>
          <button
            type="button"
            onClick={onClose}
            className="text-text-subtle hover:text-text ml-auto text-xs"
          >
            закрыть
          </button>
        </div>

        {note ? <p className="text-accent-text mb-2 text-xs">{note}</p> : null}

        {!offer ? (
          <p className="text-text-muted text-sm">Смотрим, кому подходит…</p>
        ) : offer.gone ? (
          <p className="text-text-muted text-sm leading-snug">
            Окно уже занято или прошло. Обновите расписание — предлагать туда некого.
          </p>
        ) : offer.candidates.length === 0 ? (
          <p className="text-text-muted text-sm leading-snug">
            Подходящих нет.
            {skipped > 0 ? (
              <>
                {" "}
                Из очереди «Кому позвонить» не подошли {skipped}: услуга не влезает по времени,
                кабинет или специалист не тот, писать некуда или у человека своя запись в это
                время.
              </>
            ) : null}
          </p>
        ) : (
          <>
            {offer.tight ? (
              <p className="text-accent-text mb-2 text-xs leading-snug">
                До окна меньше полутора часов — договориться могут не успеть.
              </p>
            ) : null}
            <ul className="divide-border-soft divide-y">
              {offer.candidates.map((c) => (
                <li key={c.patientId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
                  <span className="text-sm font-medium">{c.patientName}</span>
                  <span className="text-text-muted text-xs">
                    {c.serviceTitle ?? "услуга не определена"}
                    {c.serviceDurationMin ? ` · ${c.serviceDurationMin} мин` : ""}
                  </span>
                  {/* Основание — то же, что в очереди: список без него не читают. */}
                  <span className="text-text-subtle text-xs">{c.basis}</span>
                  {c.money !== null ? (
                    <span className="num text-text-subtle text-xs">{formatMoney(c.money)}</span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() =>
                      void windowStillFreeAction({ roomId, startAtIso, durationMin }).then((free) => {
                        if (!free) {
                          setNote("Окно только что заняли — писать про него уже нельзя.");
                          setOffer((o) => (o ? { ...o, gone: true } : o));
                          return;
                        }
                        if (!c.dialogId) {
                          setNote(`${c.patientName}: переписки нет — позвоните по номеру из карточки.`);
                          return;
                        }
                        window.location.href = `/inbox?d=${encodeURIComponent(c.dialogId)}`;
                      })
                    }
                    className="text-accent-text ml-auto flex-none text-xs hover:underline"
                  >
                    Написать
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-text-subtle mt-3 text-2xs leading-snug">
              Ничего не забронировано: система показывает, кому позвонить. Запись создаёт
              администратор — как и раньше.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
