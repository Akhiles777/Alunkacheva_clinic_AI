"use client";

import { useEffect, useRef, useState } from "react";
import { askAI } from "../_components/assistant-actions";
import { getOwnerAiContext } from "./actions";
import { useDb } from "@/app/_data/store";
import { answerQuery } from "@/lib/assistant/engine";

interface Msg {
  role: "user" | "assistant";
  text: string;
}

const OWNER_SUGGESTIONS = [
  "Проведи глубокий анализ клиники и дай 3 гипотезы, что улучшить",
  "Как загружены кабинеты и кто из сотрудников работает эффективнее?",
  "Где мы теряем деньги и выручку?",
];

const WELCOME: Msg = {
  role: "assistant",
  text:
    "Я ваш личный бизнес-аналитик. Вижу всю базу: загрузку кабинетов, часы и выручку по сотрудникам, " +
    "воронку, удержание. Спросите текстом — отвечу разбором по цифрам.",
};

/**
 * ИИ-аналитик владельца — только текст. Озвучивание и режим звонка убраны
 * намеренно (решение заказчика, август 2026): владелец читает разбор, а не
 * слушает его. Голос остаётся в чате сотрудников как голосовые сообщения.
 */
export function OwnerAssistant() {
  const db = useDb();
  const [messages, setMessages] = useState<Msg[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || thinking) return;
    const history = messages.filter((m) => m !== WELCOME).map((m) => ({ role: m.role, content: m.text }));
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setThinking(true);
    let answer = "";
    try {
      const context = await getOwnerAiContext();
      const res = await askAI(q, context, history, "owner");
      answer = res.text ?? answerQuery(q, db.patients).text;
    } catch {
      answer = answerQuery(q, db.patients).text;
    }
    setMessages((m) => [...m, { role: "assistant", text: answer }]);
    setThinking(false);
  }

  return (
    <section className="border-border bg-surface flex flex-col rounded-xl border">
      <div className="border-border flex items-center justify-between gap-3 border-b px-5 py-3.5 max-md:flex-col max-md:items-start max-md:gap-1">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-accent-text text-base">✦</span>
          <h2 className="text-sm font-medium">ИИ-аналитик владельца</h2>
        </div>
        <span className="text-text-subtle text-2xs">разбор по данным клиники</span>
      </div>

      <div className="flex h-[min(54vh,480px)] flex-col px-5 py-4">
        <div className="flex-1 space-y-3 overflow-auto pr-1">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-line ${
                  m.role === "user" ? "bg-accent text-accent-contrast" : "bg-hover text-text"
                }`}
              >
                {m.text}
              </div>
            </div>
          ))}
          {thinking ? (
            <div className="flex justify-start">
              <div className="bg-hover text-text-subtle rounded-2xl px-3.5 py-2 text-sm">думаю…</div>
            </div>
          ) : null}
          <div ref={endRef} />
        </div>

        {messages.length <= 1 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {OWNER_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s)}
                className="border-border text-text-muted hover:bg-hover rounded-md border px-2.5 py-1 text-xs"
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}

        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Спросите про выручку, загрузку, сотрудников…"
            className="border-border-input bg-surface placeholder:text-text-subtle min-w-0 flex-1 rounded-md border px-3 py-2 text-sm outline-none"
          />
          <button
            type="submit"
            disabled={!input.trim() || thinking}
            className="bg-accent text-accent-contrast hover:bg-accent-hover flex-none rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
          >
            Спросить
          </button>
        </form>
      </div>
    </section>
  );
}
