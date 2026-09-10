"use client";

import { useEffect, useState } from "react";
import { assemblyAction } from "./window-actions";
import type { AssemblySuggestion } from "@/lib/server/window-assembly";

/**
 * «Окна на 90 минут нет — но его можно собрать».
 *
 * Капельница занимает полтора часа, окна нарезаны по сорок минут, и
 * администратор отказывает: поставить некуда. Почти всегда рядом стоит
 * запись, которую человек и сам подвинул бы на двадцать минут.
 *
 * Предложение — не действие. Перенос делает администратор, договорившись с
 * пациентом; система не двигает чужое время ни при каких условиях, и на
 * экране это написано прямо.
 */
export function AssemblyPanel({
  roomId,
  roomName,
  dayIso,
  onClose,
}: {
  roomId: string;
  roomName: string;
  dayIso: string;
  onClose: () => void;
}) {
  const [need, setNeed] = useState(90);
  const [rows, setRows] = useState<AssemblySuggestion[] | null>(null);
  const [asked, setAsked] = useState(false);

  /**
   * Считаем по нажатию, а не при открытии панели: перебор переносов — работа
   * не бесплатная, и делать её «на всякий случай» при каждом взгляде на
   * расписание незачем. Состояние «считаем» ставится тем же нажатием, а не
   * эффектом — иначе экран перерисовывается лишний раз на каждое изменение.
   */
  useEffect(() => {
    if (!asked) return;
    let alive = true;
    void assemblyAction({ roomId, dayIso, needMin: need })
      .then((r) => alive && setRows(r))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [asked, need, roomId, dayIso]);

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
        aria-label="Собрать окно"
      >
        <div className="mb-2 flex flex-wrap items-baseline gap-3">
          <h2 className="text-md font-medium">Собрать окно</h2>
          <span className="text-text-subtle text-2xs">{roomName}</span>
          <button
            type="button"
            onClick={onClose}
            className="text-text-subtle hover:text-text ml-auto text-xs"
          >
            закрыть
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-text-muted text-sm">Нужно</span>
          <select
            value={need}
            onChange={(e) => {
              setNeed(Number(e.target.value));
              setRows(null);
              setAsked(true);
            }}
            className="border-border-input bg-surface rounded-md border px-2 py-1.5 text-sm outline-none"
          >
            {[60, 90, 120, 150].map((m) => (
              <option key={m} value={m}>
                {m} мин
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setRows(null);
              setAsked(true);
            }}
            className="bg-accent text-accent-contrast rounded-md px-3 py-1.5 text-sm font-medium"
          >
            Найти
          </button>
        </div>

        {!asked ? (
          <p className="text-text-muted mt-3 text-sm leading-snug">
            Покажем, какой один перенос освободит столько времени в этом кабинете. Двигать будем
            только тех, кто ходит регулярно, и не завтрашние записи — договориться нужно успеть.
          </p>
        ) : rows === null ? (
          <p className="text-text-muted mt-3 text-sm">Считаем…</p>
        ) : rows.length === 0 ? (
          <p className="text-text-muted mt-3 text-sm leading-snug">
            Собрать не получится: подходящего переноса нет. Первичных и тех, кому и так звонят, мы
            не двигаем, а сдвиг больше двух часов не предлагаем.
          </p>
        ) : (
          <>
            <ul className="mt-3 divide-border-soft divide-y">
              {rows.map((r) => (
                <li key={r.bookingId} className="py-2.5">
                  <div className="text-sm">
                    Перенести <span className="font-medium">{r.patientName}</span> ({r.serviceTitle})
                    с <span className="num">{r.fromTime}</span> на{" "}
                    <span className="num">{r.toTime}</span> — сдвиг {r.shiftMin} мин
                  </div>
                  <div className="text-text-muted mt-0.5 text-xs">
                    освободится {r.freedFrom}–{r.freedTo} ({r.freedMin} мин)
                    {r.staffName ? ` · тот же специалист: ${r.staffName}` : ""}
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-accent-text mt-3 text-xs leading-snug">
              Нужно согласовать с пациентом. Система ничего не переносит сама: позвоните, а потом
              подвиньте запись в YCLIENTS или в панели записи.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
