"use client";

import { useEffect, useState } from "react";
import { dialogBriefAction, type DialogBriefView } from "../inbox/assistant-actions";
import { answerAboutPatient, SUGGESTED_QUESTIONS, type PatientAnswer } from "@/lib/metrics/patient-answer";
import { visitTitle } from "@/lib/visit-title";
import { getPatientRecord } from "@/app/(dashboard)/patients/actions";
import { hydratePatients, type Patient } from "@/app/_data/store";

/**
 * Ассистент администратора — одним блоком: сводка переписки и вопросы про
 * пациента.
 *
 * Прежде сводка пряталась словом «Что это за пациент» под полем ввода, а
 * вопросов не было вовсе, и заказчик справедливо спросил, где ассистент и
 * зачем эта ссылка, если справа есть «Личное дело». Теперь он стоит в правой
 * колонке рядом с делом, а под перепиской открывается только там, где правой
 * колонки нет (узкий экран, телефон).
 *
 * Ничего не отправляет и не пишет в переписку. Сводку и ответы считает наш
 * код из своих данных; во внешнюю модель не уходит ни слова (§7). Ответы — из
 * тех же данных, что нарисованы в карточке, поэтому разойтись с ней не могут.
 */
/**
 * Сводка по диалогу — один раз на вкладку.
 *
 * Блок стоит в правой колонке и собирается при открытии КАЖДОЙ переписки, а
 * сам запрос пишет строку в журнал доступа (§7): администратор щёлкает по
 * списку диалогов туда-обратно — и журнал заполняется отметками об одном и том
 * же, а сервер считает сводку заново. Отметка о доступе при этом не теряется:
 * первое открытие пишется как прежде, а открытие диалога само по себе
 * записывается отдельно (`noteDialogOpen`).
 */
const briefCache = new Map<string, DialogBriefView>();

/**
 * Карточки, историю которых уже догрузили в этой вкладке.
 *
 * Список пациентов приходит БЕЗ визитов — их тянут только с карточкой. На
 * широком экране историю догружает сама карточка справа, а на телефоне её на
 * экране нет вовсе: ассистент отвечал бы «состоявшихся визитов ещё не было» у
 * человека с двадцатью визитами. Пустой массив здесь означает «не спрашивали»,
 * и отвечать по нему нельзя.
 */
const recordLoaded = new Set<string>();

/** Сколько визитов приходит с карточкой (`getPatientRecord`, take: 100). */
const VISITS_IN_CARD = 100;

export function AdminAssistant({ dialogId, patient }: { dialogId: string; patient: Patient | null }) {
  const [brief, setBrief] = useState<DialogBriefView | null>(() => briefCache.get(dialogId) ?? null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<(PatientAnswer & { q: string }) | null>(null);
  /**
   * История визитов уже у нас — до этого отвечать нельзя, соврём.
   *
   * Готовность не состояние, а факт: карточка либо догружена в этой вкладке,
   * либо нет. Счётчик нужен только чтобы перерисовать блок, когда она пришла.
   */
  const [, redraw] = useState(0);
  const ready = patient === null || recordLoaded.has(patient.id);

  useEffect(() => {
    if (!patient || recordLoaded.has(patient.id)) return;
    let alive = true;
    const at = Date.now();
    getPatientRecord(patient.id)
      .then((record) => {
        if (record) hydratePatients([record], at);
        recordLoaded.add(patient.id);
        if (alive) redraw((n) => n + 1);
      })
      .catch(() => {
        // Не догрузилось — вопросы остаются недоступными, а не отвечают наугад.
      });
    return () => {
      alive = false;
    };
  }, [patient?.id, patient]);

  useEffect(() => {
    if (briefCache.has(dialogId)) return;
    let alive = true;
    void dialogBriefAction(dialogId)
      .then((b) => {
        briefCache.set(dialogId, b);
        if (alive) setBrief(b);
      })
      .catch(() => alive && setBrief({ lines: [], topics: [] }));
    return () => {
      alive = false;
    };
  }, [dialogId]);

  function ask(q: string) {
    const text = q.trim();
    if (!text || !patient || !ready) return;
    setAnswer({
      q: text,
      ...answerAboutPatient(text, {
        visits: patient.visits.map((v) => ({
          status: v.status,
          at: v.at,
          amount: v.amount,
          paidEarlier: v.paidEarlier,
          service: v.service,
          doctor: v.doctor,
          kind: v.kind,
          title: visitTitle(v.parts, v.service),
        })),
        /**
         * Карточка отдаёт последние сто визитов. Дошли до этой границы —
         * ассистент говорит об этом сам, а не выдаёт часть за целое.
         */
        truncated: patient.visits.filter((v) => v.kind !== "purchase").length >= VISITS_IN_CARD,
        courses: patient.courses.map((c) => ({
          title: c.title,
          used: c.used,
          total: c.total,
          booked: c.booked,
          status: c.status,
        })),
      }),
    });
    setQuestion("");
  }

  return (
    <div className="flex flex-col gap-2">
      {brief === null ? (
        <p className="text-text-subtle text-xs">Смотрим переписку…</p>
      ) : brief.lines.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {brief.lines.map((l) => (
            <p key={l} className="text-text-muted text-xs leading-snug">
              {l}
            </p>
          ))}
          {brief.topics.length > 0 ? (
            <p className="text-text-subtle text-2xs">Спрашивал про: {brief.topics.join(", ")}.</p>
          ) : null}
        </div>
      ) : null}

      {patient ? (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
            className="flex gap-1.5"
          >
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={!ready}
              placeholder={
                ready ? "Спросить про пациента: «должен ли что-то?»" : "Открываем историю визитов…"
              }
              className="border-border-input bg-surface placeholder:text-text-subtle min-w-0 flex-1 rounded-md border px-2.5 py-1.5 text-xs outline-none"
            />
            <button
              type="submit"
              disabled={!ready || !question.trim()}
              className="bg-accent text-accent-contrast rounded-md px-2.5 py-1.5 text-xs font-medium disabled:opacity-45"
            >
              Спросить
            </button>
          </form>
          <div className="flex flex-wrap gap-1">
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => ask(q)}
                disabled={!ready}
                className="border-border text-text-muted hover:bg-hover hover:text-text rounded-md border px-2 py-0.5 text-2xs disabled:opacity-45"
              >
                {q}
              </button>
            ))}
          </div>
          {answer ? (
            <div className="bg-hover rounded-md px-2.5 py-2">
              <div className="text-text-subtle text-2xs">{answer.q}</div>
              <div className={`text-xs leading-snug ${answer.known ? "text-text" : "text-text-muted"}`}>
                {answer.text}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-text-subtle text-2xs leading-snug">
          Вопросы про визиты, курсы и оплату — после привязки переписки к карточке клиента.
        </p>
      )}

      <p className="text-text-subtle text-2xs">
        Считается у нас, из своих данных. Пациенту ничего не уходит, во внешние сервисы — тоже.
      </p>
    </div>
  );
}
