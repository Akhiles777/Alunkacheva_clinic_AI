"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatMoney, formatNumber } from "@/lib/format";
import { ComposeOverlay } from "../_components/compose-overlay";
import { noteOutreach } from "./actions";
import type { CandidateKind } from "@/lib/metrics/callback-queue";

/**
 * «Кому позвонить» — рабочая очередь администратора.
 *
 * Экран ничего не считает: строки, суммы и основания приходят готовыми из
 * `lib/server/callback-queue.ts`, а тот — из чистых функций `lib/metrics/`.
 *
 * Три правила, из которых он вырос:
 *
 *   — у каждой строки написано ЕЁ основание. Список без основания читается
 *     как «система так решила», и по нему перестают звонить;
 *   — состояние 24-часового окна видно ДО того, как человек начал писать.
 *     Раньше это выяснялось после нажатия — по сообщению, повисшему в
 *     «отправляется»;
 *   — из списка убирает только настоящая будущая запись. Отправленное
 *     сообщение не убирает: «написали» — это ещё не «придёт».
 */

export interface QueueRowView {
  patientId: string;
  patientName: string;
  kind: CandidateKind;
  basis: string;
  money: number | null;
  moneyKind: "PREPAID" | "POTENTIAL";
  days: number | null;
  courseId: string | null;
  contact: {
    channel: "whatsapp" | "instagram" | "telegram" | null;
    windowOpen: boolean;
    windowHoursLeft: number | null;
    hasDialog: boolean;
    phone: string | null;
  };
}

export interface FreeSlotDayView {
  date: string;
  label: string;
  windows: { roomName: string; from: string; to: string; durationMin: number }[] | null;
  closedLabel: string | null;
}

export interface QueueData {
  rows: QueueRowView[];
  withoutThreshold: number;
  outcome: { outreaches: number; booked: number; arrived: number; revenue: number; days: number };
  slots: FreeSlotDayView[];
  attributionDays: number;
}

const KIND_LABEL: Record<CandidateKind, string> = {
  COURSE_STALLED: "выпал из курса",
  COURSE_FINISHING: "курс на финише",
  NO_SHOW: "не пришёл",
  SLEEPING: "давно не был",
};

const FILTERS: { id: CandidateKind | "all"; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "COURSE_STALLED", label: "Выпали из курса" },
  { id: "COURSE_FINISHING", label: "Курс на финише" },
  { id: "NO_SHOW", label: "Не пришли" },
  { id: "SLEEPING", label: "Давно не были" },
];

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  telegram: "Telegram",
};

/** Деньги подписаны по смыслу: оплаченное вперёд — не то же, что цена по прайсу. */
function moneyHint(kind: QueueRowView["moneyKind"]): string {
  return kind === "PREPAID" ? "оплачено вперёд" : "цена по прайсу";
}

/**
 * Состояние окна — до попытки отправки.
 *
 * В закрытое окно свободный текст не уйдёт. Написать об этом нужно раньше,
 * чем человек набрал сообщение, а не после.
 */
function windowNote(contact: QueueRowView["contact"]): { text: string; warn: boolean } {
  if (!contact.hasDialog) {
    return {
      text: contact.phone ? `переписки нет · ${contact.phone}` : "переписки нет · телефона тоже",
      warn: true,
    };
  }
  const channel = contact.channel ? CHANNEL_LABEL[contact.channel] : "канал неизвестен";
  /**
   * Telegram здесь не обслуживается: оверлей умеет начинать разговор в
   * Instagram и WhatsApp, а телеграмный диалог живёт в «Диалогах». Отправить
   * его через WhatsApp значило бы написать не туда — молча и не тому каналу.
   */
  if (contact.channel === "telegram") {
    return { text: `${channel} · открыть в «Диалогах»`, warn: true };
  }
  if (contact.windowOpen) {
    return {
      text: `${channel} · окно открыто${
        contact.windowHoursLeft !== null ? `, осталось ${contact.windowHoursLeft} ч` : ""
      }`,
      warn: false,
    };
  }
  return { text: `${channel} · окно закрыто — свободный текст не уйдёт`, warn: true };
}

export function QueueClient({ data }: { data: QueueData }) {
  const [filter, setFilter] = useState<CandidateKind | "all">("all");
  const [writeTo, setWriteTo] = useState<QueueRowView | null>(null);
  const [written, setWritten] = useState<Set<string>>(new Set());

  const rows = useMemo(
    () => (filter === "all" ? data.rows : data.rows.filter((r) => r.kind === filter)),
    [data.rows, filter],
  );

  const total = rows.reduce((sum, r) => sum + (r.money ?? 0), 0);

  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Кому позвонить</h1>
        <p className="text-text-muted mt-1.5 max-w-[70ch] text-xs leading-relaxed max-md:hidden">
          Список отсортирован по деньгам. У каждой строки написано основание — то, что
          администратор говорит вслух. Из списка убирает только настоящая будущая запись:
          отправленное сообщение не убирает.
        </p>
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const n = f.id === "all" ? data.rows.length : data.rows.filter((r) => r.kind === f.id).length;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`rounded-md px-2.5 py-1 text-xs ${
                  filter === f.id
                    ? "bg-accent text-accent-contrast"
                    : "border-border text-text-muted hover:bg-hover border"
                }`}
              >
                {f.label} <span className="num">{formatNumber(n)}</span>
              </button>
            );
          })}
        </div>
      </header>

      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex gap-6 max-lg:flex-col">
          <div className="min-w-0 flex-1">
            {/* ── что дал список */}
            <div className="border-border bg-surface mb-4 rounded-xl border px-4 py-3">
              {data.outcome.outreaches === 0 ? (
                <p className="text-text-muted text-sm">
                  Из этого списка пока никому не писали — считать нечего. Как только напишете,
                  здесь появится, сколько человек записалось в течение {data.attributionDays} дней.
                </p>
              ) : (
                <p className="text-text-muted text-sm leading-relaxed">
                  За {data.outcome.days} дней написали{" "}
                  <b className="num text-text">{formatNumber(data.outcome.outreaches)}</b>, из них
                  записались за {data.attributionDays} дней{" "}
                  <b className="num text-text">{formatNumber(data.outcome.booked)}</b>, дошли{" "}
                  <b className="num text-text">{formatNumber(data.outcome.arrived)}</b> на{" "}
                  <b className="num text-text">{formatMoney(data.outcome.revenue)}</b>.{" "}
                  <span className="text-text-subtle">
                    Деньги — только состоявшихся визитов: цена будущей записи ещё не деньги.
                  </span>
                </p>
              )}
            </div>

            {rows.length === 0 ? (
              <div className="border-border bg-surface rounded-xl border px-4 py-6">
                <p className="text-text-muted text-sm">
                  {data.rows.length === 0
                    ? "Звонить некому: у всех, кто мог бы попасть в список, есть будущая запись."
                    : "В этом разрезе никого нет."}
                </p>
              </div>
            ) : (
              <>
                <p className="text-text-subtle mb-2 text-2xs">
                  {formatNumber(rows.length)} человек · {formatMoney(total)} на кону
                </p>
                <ul className="flex flex-col gap-2">
                  {rows.map((r) => {
                    const note = windowNote(r.contact);
                    return (
                      <li
                        key={r.patientId}
                        className="border-border bg-surface rounded-lg border px-3.5 py-3"
                      >
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <Link
                            href={`/patients/${r.patientId}`}
                            className="text-sm font-medium hover:underline"
                          >
                            {r.patientName}
                          </Link>
                          <span className="text-text-subtle text-2xs">{KIND_LABEL[r.kind]}</span>
                          <span className="num text-text ml-auto text-sm">
                            {r.money === null ? "сумма неизвестна" : formatMoney(r.money)}
                          </span>
                          {r.money === null ? null : (
                            <span className="text-text-subtle w-full text-right text-2xs sm:w-auto">
                              {moneyHint(r.moneyKind)}
                            </span>
                          )}
                        </div>

                        {/* Основание — то, ради чего строка существует. */}
                        <p className="text-text-muted mt-1 text-xs leading-relaxed">{r.basis}</p>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span
                            className={`text-2xs ${note.warn ? "text-accent-text" : "text-text-subtle"}`}
                          >
                            {note.text}
                          </span>
                          <button
                            type="button"
                            onClick={() => setWriteTo(r)}
                            disabled={!r.contact.hasDialog || r.contact.channel === "telegram"}
                            className="border-border text-text-muted hover:bg-hover ml-auto rounded-md border px-2.5 py-1 text-2xs disabled:cursor-not-allowed disabled:opacity-45"
                            title={
                              !r.contact.hasDialog
                                ? "Переписки с этим пациентом нет — писать первым некуда"
                                : r.contact.channel === "telegram"
                                  ? "Телеграмный диалог открывается в «Диалогах»"
                                  : "Открыть диалог, не уходя со списка"
                            }
                          >
                            Написать
                          </button>
                          {written.has(r.patientId) ? (
                            <span className="text-text-subtle text-2xs">
                              написали · из списка уберёт только запись
                            </span>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {data.withoutThreshold > 0 ? (
              <p className="text-text-subtle mt-3 text-2xs">
                Ещё {formatNumber(data.withoutThreshold)} человек не в списке: у их услуги не задан
                порог «пора звать», а запасного порога клиники нет. Через сколько дней человек
                считается потерянным — решает клиника:{" "}
                <Link href="/settings/services" className="hover:underline">
                  Настройки → Услуги
                </Link>{" "}
                или{" "}
                <Link href="/settings/clinic" className="hover:underline">
                  Настройки → Клиника
                </Link>
                .
              </p>
            ) : null}
          </div>

          {/* ── свободные окна: что предложить прямо в разговоре */}
          <aside className="w-[300px] flex-none max-lg:w-full">
            <h2 className="text-text-muted mb-2 text-2xs">Свободные окна на три дня</h2>
            <div className="flex flex-col gap-3">
              {data.slots.map((d) => (
                <div key={d.date} className="border-border bg-surface rounded-xl border px-3.5 py-3">
                  <div className="text-sm font-medium">{d.label}</div>
                  {d.windows === null ? (
                    <p className="text-text-subtle mt-1 text-2xs">
                      клиника не работает · {d.closedLabel}
                    </p>
                  ) : d.windows.length === 0 ? (
                    <p className="text-text-subtle mt-1 text-2xs">свободных окон нет</p>
                  ) : (
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {d.windows.slice(0, 6).map((w, i) => (
                        <li key={i} className="flex items-baseline gap-2 text-xs">
                          <span className="num text-text w-[92px] flex-none">
                            {w.from}–{w.to}
                          </span>
                          <span className="text-text-subtle min-w-0 flex-1 truncate">
                            {w.roomName}
                          </span>
                        </li>
                      ))}
                      {d.windows.length > 6 ? (
                        <li className="text-text-subtle text-2xs">
                          и ещё {d.windows.length - 6}
                        </li>
                      ) : null}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>

      {writeTo ? (
        <ComposeOverlay
          onClose={() => setWriteTo(null)}
          prefillPatientId={writeTo.patientId}
          prefillChannel={writeTo.contact.channel === "instagram" ? "instagram" : "whatsapp"}
          onSent={() => {
            /**
             * Отмечаем факт обращения — по нему считается, что дал список.
             * Человека из очереди это не убирает: уберёт только запись.
             */
            void noteOutreach({
              patientId: writeTo.patientId,
              kind: writeTo.kind,
              basis: writeTo.basis,
              money: writeTo.money,
            }).catch(() => {});
            setWritten((cur) => new Set(cur).add(writeTo.patientId));
          }}
        />
      ) : null}
    </>
  );
}
