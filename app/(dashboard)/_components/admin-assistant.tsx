"use client";

import { useEffect, useState } from "react";
import { dialogBriefAction, type DialogBriefView } from "../inbox/assistant-actions";
import { answerAboutPatient, SUGGESTED_QUESTIONS, type PatientAnswer } from "@/lib/metrics/patient-answer";
import { visitTitle } from "@/lib/visit-title";
import type { Patient } from "@/app/_data/store";

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
export function AdminAssistant({ dialogId, patient }: { dialogId: string; patient: Patient | null }) {
  const [brief, setBrief] = useState<DialogBriefView | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<(PatientAnswer & { q: string }) | null>(null);

  useEffect(() => {
    let alive = true;
    void dialogBriefAction(dialogId)
      .then((b) => alive && setBrief(b))
      .catch(() => alive && setBrief({ lines: [], topics: [] }));
    return () => {
      alive = false;
    };
  }, [dialogId]);

  function ask(q: string) {
    const text = q.trim();
    if (!text || !patient) return;
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
              placeholder="Спросить про пациента: «должен ли что-то?»"
              className="border-border-input bg-surface placeholder:text-text-subtle min-w-0 flex-1 rounded-md border px-2.5 py-1.5 text-xs outline-none"
            />
            <button
              type="submit"
              disabled={!question.trim()}
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
                className="border-border text-text-muted hover:bg-hover hover:text-text rounded-md border px-2 py-0.5 text-2xs"
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
