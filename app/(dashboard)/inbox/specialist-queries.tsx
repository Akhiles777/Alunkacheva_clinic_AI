"use client";

import { useEffect, useState } from "react";
import { listSpecialistQueries, type SpecialistQueryView } from "./dialog-actions";

/**
 * Вопрос специалисту — прямо в переписке пациента.
 *
 * Агент пересылает сложный вопрос врачу в её WhatsApp и пересказывает ответ
 * пациенту. Переписка с врачом в инбокс не попадает намеренно: врач — не
 * пациент (§6). Но администратор из-за этого не видел ничего: в диалоге стояло
 * «уточню у врача», а что спросили и что она ответила, находилось только в
 * кабинете Green API. Заказчик так и нашёл — и сначала решил, что вопросы не
 * уходят вовсе.
 *
 * Служебный блок, а не сообщения: наружу он не уходит и в ленту переписки не
 * смешивается. Ответ врача показан ДОСЛОВНО, рядом — что в итоге ушло пациенту:
 * если формулировки разошлись, администратор должен это видеть.
 */

const STATUS: Record<SpecialistQueryView["status"], string> = {
  SENT: "ждём ответа",
  ANSWERED: "ответ передан пациенту",
  DECLINED: "врач попросила не отвечать — разбирается сама",
  STALE: "ответа не дождались — вопрос у администратора",
};

/** Как часто перечитываем, пока вопрос ждёт ответа. */
const POLL_MS = 20_000;

export function SpecialistQueries({ dialogId }: { dialogId: string }) {
  const [rows, setRows] = useState<SpecialistQueryView[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    /** Ждём ли ответа сейчас — решает, нужен ли следующий опрос. */
    let waiting = false;
    const load = () =>
      listSpecialistQueries(dialogId)
        .then((r) => {
          if (!alive) return;
          waiting = r.some((q) => q.status === "SENT");
          setRows(r);
        })
        .catch(() => {
          // Не загрузилось — переписка работает; блок просто не покажется.
        });
    void load();
    /**
     * Перечитываем, только пока есть вопрос без ответа: ответ врача приходит
     * в любой момент, и администратору важно увидеть его без перезагрузки.
     * Когда ждать нечего, лишних запросов нет.
     */
    const timer = setInterval(() => {
      if (waiting) void load();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [dialogId]);

  if (rows.length === 0) return null;

  const latest = rows[0];
  const waiting = latest.status === "SENT";

  return (
    <div className="border-border-soft bg-hover flex-none border-b px-5 py-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-2 text-left"
      >
        {/*
          Имя через точку, а не в падеже: «Вопрос Ирине Алилгаджиевне» пришлось
          бы склонять кодом, и однажды это вышло бы неправильно на чьей-нибудь
          фамилии (так же решено в самом агенте).
        */}
        <span className="text-text font-medium">
          Вопрос специалисту · {latest.specialist}
          {rows.length > 1 ? ` · всего ${rows.length}` : ""}
        </span>
        <span className={waiting ? "text-accent-text" : "text-text-subtle"}>
          {STATUS[latest.status]}
        </span>
        <span className="text-text-subtle ml-auto flex-none">{open ? "свернуть" : "подробнее"}</span>
      </button>

      {open ? (
        <ul className="mt-2 flex flex-col gap-3">
          {rows.map((q) => (
            <li key={q.id} className="border-border-soft flex flex-col gap-1.5 border-l-2 pl-3">
              <div className="text-text-subtle text-2xs">
                #{q.ref} · {q.specialist} · отправлено {q.askedAt} · {STATUS[q.status]}
              </div>

              {q.messages.length > 0 ? (
                /**
                 * Переписка со специалистом целиком, как в мессенджере. Подпись
                 * «агент» — письмо ушло из платформы, а не от сотрудника: так
                 * оно и было отправлено. Ответ, который агент не смог отнести к
                 * вопросу, помечен — пересылку по нему решает человек.
                 */
                <ul className="flex flex-col gap-1.5">
                  {q.messages.map((m) => (
                    <li key={m.id}>
                      <div className="text-text-subtle text-2xs">
                        {m.author} · {m.at}
                        {!m.linked ? " · к какому вопросу — неясно: открытых было несколько" : ""}
                      </div>
                      <div
                        className={`whitespace-pre-wrap ${m.fromSpecialist ? "text-text" : "text-text-muted"}`}
                      >
                        {m.body}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <>
                  <div>
                    <div className="text-text-subtle text-2xs">Ушло врачу</div>
                    <div className="text-text whitespace-pre-wrap">{q.question}</div>
                  </div>
                  {q.answer ? (
                    <div>
                      <div className="text-text-subtle text-2xs">
                        Ответ врача, дословно{q.answeredAt ? ` · ${q.answeredAt}` : ""}
                      </div>
                      <div className="text-text whitespace-pre-wrap">{q.answer}</div>
                    </div>
                  ) : null}
                </>
              )}

              {/*
                Пересказ показываем, только если он отличается от ответа:
                одинаковый текст дважды — шум, а расхождение администратор
                обязан заметить.
              */}
              {q.relayed && q.relayed.trim() !== (q.answer ?? "").trim() ? (
                <div>
                  <div className="text-text-subtle text-2xs">Ушло пациенту</div>
                  <div className="text-text whitespace-pre-wrap">{q.relayed}</div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
