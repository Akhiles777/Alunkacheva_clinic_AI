"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "./modal";
import { askAI } from "./assistant-actions";
import { useDb } from "@/app/_data/store";
import { answerQuery, SUGGESTIONS } from "@/lib/assistant/engine";
import { buildAssistantContext } from "@/lib/assistant/context";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

const WELCOME: ChatMessage = {
  role: "assistant",
  text:
    "Привет! Я ассистент по клинике. Вижу всю базу на чтение — пациентов, визиты, курсы, диалоги, звонки. " +
    "Спросите сводку, интервал визитов клиента, кого пора вернуть на курс, откуда приходят пациенты.",
};

/**
 * Глобальный ИИ-ассистент: плашка есть на всех страницах. Отвечает реальным ИИ
 * (routerai.ru) по аналитической выжимке базы; если ИИ недоступен — падаем на
 * локальный движок, чтобы не оставить пользователя без ответа.
 */
export function AssistantChat() {
  const db = useDb();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking, open]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || thinking) return;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setThinking(true);
    try {
      const context = buildAssistantContext(db);
      // Память диалога: отдаём накопленные реплики (кроме приветствия) как историю.
      const history = messages
        .filter((m) => m !== WELCOME)
        .map((m) => ({ role: m.role, content: m.text }));
      const res = await askAI(q, context, history);
      const answer = res.text ?? answerQuery(q, db.patients).text;
      setMessages((m) => [...m, { role: "assistant", text: answer }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", text: answerQuery(q, db.patients).text }]);
    } finally {
      setThinking(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Спросить ИИ"
        className="border-accent-border bg-accent text-accent-contrast hover:bg-accent-hover fixed right-5 bottom-5 z-40 inline-flex items-center gap-2 rounded-pill border px-4 py-2.5 text-sm font-medium max-md:right-4 max-md:bottom-4"
      >
        <span aria-hidden className="text-base leading-none">✦</span>
        <span className="max-md:hidden">Спросить ИИ</span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Ассистент клиники"
        description="Аналитика и ответы по всей базе — только чтение"
      >
        <div className="flex h-[min(62vh,580px)] flex-col max-md:h-[72vh]">
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
              {SUGGESTIONS.map((s) => (
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
              placeholder="Спросите про пациента, визиты, курсы…"
              className="border-border-input bg-surface placeholder:text-text-subtle flex-1 rounded-md border px-3 py-2 text-sm outline-none"
            />
            <button
              type="submit"
              disabled={!input.trim() || thinking}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
            >
              Спросить
            </button>
          </form>
        </div>
      </Modal>
    </>
  );
}
