"use client";

import { useEffect, useRef, useState } from "react";
import {
  askAdmin,
  clearAdminChat,
  confirmBroadcast,
  getAdminChat,
  type AdminChatTurn,
} from "./admin-chat-actions";
import { ADMIN_ABILITIES, type BroadcastPlan } from "@/lib/assistant/admin-intents";
import { noteUse } from "../_components/usage-actions";

/**
 * Чат ассистента администратора — отдельным разговором в «Диалогах».
 *
 * Это не переписка с пациентом: наружу отсюда ничего не уходит само. Ассистент
 * отвечает по данным клиники (считает наш код, не модель) и готовит рассылки,
 * которые уходят только после того, как человек увидел текст, поимённый список
 * получателей и нажал «Отправить».
 */

const HINTS = [
  "Сколько пациентов сегодня у Ирины Алилгаджиевны на остеопатию?",
  "На какую сумму сегодня?",
  "Сколько ещё осталось принять?",
  "Кто записан завтра?",
  "Какие свободные окна сегодня?",
  "Кто не пришёл сегодня?",
];

export function AssistantThread({ onBack }: { onBack: () => void }) {
  const [turns, setTurns] = useState<AdminChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** План рассылки ждёт подтверждения: до нажатия не уходит ничего. */
  const [plan, setPlan] = useState<BroadcastPlan | null>(null);
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    void getAdminChat()
      .then((chat) => {
        if (!alive) return;
        setTurns(chat.turns);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const box = listRef.current;
    if (box) box.scrollTo({ top: box.scrollHeight });
  }, [turns.length, plan, thinking]);

  function ask(question: string) {
    const text = question.trim();
    if (!text || thinking) return;
    setTurns((t) => [...t, { role: "user", text }]);
    setInput("");
    setThinking(true);
    setPlan(null);
    void noteUse("assistant");
    void askAdmin(text)
      .then((answer) => {
        setTurns((t) => [...t, answer]);
        if (answer.plan) setPlan(answer.plan);
      })
      .catch(() =>
        setTurns((t) => [
          ...t,
          { role: "assistant", text: "Не получилось посчитать — нет связи с сервером. Повторите вопрос." },
        ]),
      )
      .finally(() => setThinking(false));
  }

  function send() {
    if (!plan || sending) return;
    setSending(true);
    void noteUse("broadcast");
    void confirmBroadcast({
      dayIso: plan.dayIso,
      staffId: plan.staffId,
      serviceId: plan.serviceId,
      text: plan.text,
      patientId: plan.patientId,
      sendAtIso: plan.sendAtIso,
    })
      .then((res) => {
        setTurns((t) => [...t, { role: "assistant", text: res.text }]);
        setPlan(null);
      })
      .catch(() =>
        setTurns((t) => [
          ...t,
          { role: "assistant", text: "Рассылка не ушла — нет связи с сервером. Ничего не отправлено." },
        ]),
      )
      .finally(() => setSending(false));
  }

  const willSend = plan?.targets.filter((t) => t.blocked === null) ?? [];
  const blocked = plan?.targets.filter((t) => t.blocked !== null) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-border-soft flex flex-none items-baseline gap-3 border-b px-5 py-3">
        <button type="button" onClick={onBack} className="text-text-subtle hover:text-text text-xs md:hidden">
          ← Диалоги
        </button>
        <div className="min-w-0">
          <div className="text-md font-medium">Ассистент администратора</div>
          <div className="text-text-subtle text-2xs">
            считает по данным клиники · наружу ничего не уходит без вашего подтверждения
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            void clearAdminChat().then(() => setTurns([]));
            setPlan(null);
          }}
          className="text-text-subtle hover:text-text ml-auto flex-none text-xs"
        >
          очистить
        </button>
      </header>

      <div ref={listRef} className="flex-1 overflow-auto px-5 py-4">
        {!loaded ? (
          <p className="text-text-subtle text-sm">Открываем разговор…</p>
        ) : turns.length === 0 ? (
          <div className="text-text-muted max-w-[62ch] text-sm leading-relaxed">
            <p>
              Спросите про сегодняшний день, врача, услугу или пациента — отвечу числами из базы. Могу
              подготовить рассылку записанным: покажу текст и поимённый список, отправлю только после
              вашего подтверждения.
            </p>
            <ul className="mt-3 flex flex-col gap-1">
              {ADMIN_ABILITIES.map((a) => (
                <li key={a} className="text-text-subtle text-xs">
                  • {a}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {turns.map((t, i) => (
              <div
                key={`${i}-${t.text.slice(0, 12)}`}
                className={`max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm whitespace-pre-wrap ${
                  t.role === "user"
                    ? "bg-accent text-accent-contrast self-end"
                    : "bg-hover text-text self-start"
                }`}
              >
                {t.text}
              </div>
            ))}
            {thinking ? <div className="text-text-subtle text-xs">Считаю…</div> : null}
          </div>
        )}

        {/*
          Рассылка до отправки: текст дословно, поимённый список и кому не
          уйдёт. Это единственное место, где можно ошибиться адресатом, поэтому
          оно показано целиком, а не числом.
        */}
        {plan ? (
          <div className="border-accent-border bg-accent-tint mt-3 rounded-xl border p-3.5">
            <div className="text-text text-sm font-medium">
              {plan.kind === "one" ? "Проверьте сообщение" : "Проверьте рассылку"}
            </div>
            <div className="border-border-soft bg-surface mt-2 rounded-md border px-3 py-2 text-sm whitespace-pre-wrap">
              {plan.text}
            </div>
            <div className="text-text-muted mt-2 text-xs">
              {/*
                Имя врача после слова «Получатель» читалось как адресат:
                «Получатель · Ирина Алилгаджиевна», хотя писали пациентке.
                Поэтому у письма одному человеку здесь стоит ЕГО имя, а врач
                подписан отдельно.
              */}
              {plan.kind === "one"
                ? `Получатель: ${plan.targets[0]?.name ?? "—"}`
                : `Уйдёт ${willSend.length} ${willSend.length === 1 ? "пациенту" : "пациентам"}`}
              {plan.staffName ? ` · врач ${plan.staffName}` : ""} · {plan.dateLabel}
              {/*
                Когда уйдёт — отдельной строкой и словами: «через пять часов»
                администратор сказал, а увидеть он должен точный момент.
              */}
              {plan.sendAtLabel ? (
                <span className="text-accent-text"> · отправлю {plan.sendAtLabel}</span>
              ) : null}
            </div>
            <ul className="mt-1.5 flex max-h-40 flex-col gap-0.5 overflow-auto">
              {willSend.map((t) => (
                <li key={t.patientId} className="text-text-muted text-xs">
                  • {t.name} — {t.when}
                </li>
              ))}
            </ul>
            {blocked.length > 0 ? (
              <div className="text-text-subtle mt-2 text-xs">
                Не уйдёт {blocked.length}:{" "}
                {blocked.map((t) => `${t.name} (${t.blocked})`).join(", ")}
              </div>
            ) : null}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={send}
                disabled={sending || willSend.length === 0}
                className="bg-accent text-accent-contrast rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-45"
              >
                {sending
                  ? plan.sendAtIso
                    ? "Откладываю…"
                    : "Отправляю…"
                  : plan.sendAtIso
                    ? `Запланировать${plan.kind === "one" ? "" : ` ${willSend.length}`}`
                    : plan.kind === "one"
                      ? "Отправить"
                      : `Отправить ${willSend.length}`}
              </button>
              <button
                type="button"
                onClick={() => setPlan(null)}
                className="text-text-muted hover:text-text text-sm"
              >
                Отмена
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {turns.length === 0 && loaded ? (
        <div className="border-border-soft flex flex-none flex-wrap gap-1.5 border-t px-5 py-2">
          {HINTS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => ask(h)}
              className="border-border text-text-muted hover:bg-hover hover:text-text rounded-md border px-2 py-0.5 text-2xs"
            >
              {h}
            </button>
          ))}
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="border-border-soft flex flex-none items-end gap-2 border-t px-5 py-3"
      >
        <textarea
          value={input}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(input);
            }
          }}
          placeholder="Спросите про день, врача, пациента — или попросите разослать сообщение записанным"
          className="border-border-input bg-surface placeholder:text-text-subtle min-w-0 flex-1 resize-none rounded-md border px-3 py-2 text-sm outline-none"
        />
        <button
          type="submit"
          disabled={!input.trim() || thinking}
          className="bg-accent text-accent-contrast rounded-md px-3.5 py-2 text-sm font-medium disabled:opacity-45"
        >
          Спросить
        </button>
      </form>
    </div>
  );
}
