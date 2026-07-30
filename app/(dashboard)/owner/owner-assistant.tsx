"use client";

import { useEffect, useRef, useState } from "react";
import { askAI } from "../_components/assistant-actions";
import { getOwnerAiContext } from "./actions";
import { useDb } from "@/app/_data/store";
import { answerQuery } from "@/lib/assistant/engine";
import { useVoice } from "@/lib/voice";

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
    "воронку, удержание. Спросите текстом, зажмите микрофон, чтобы сказать голосом, или позвоните мне.",
};

export function OwnerAssistant() {
  const db = useDb();
  const voice = useVoice();
  const [messages, setMessages] = useState<Msg[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [voiceOut, setVoiceOut] = useState(true);
  const [inCall, setInCall] = useState(false);
  const inCallRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  // Возвращает текст ответа; при voice=true — озвучивает и ждёт окончания.
  async function ask(text: string, voiceReply: boolean): Promise<string> {
    const q = text.trim();
    if (!q) return "";
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
    if (voiceReply && answer) await voice.speak(answer);
    return answer;
  }

  // ── звонок: непрерывный диалог ──
  function callTurn() {
    if (!inCallRef.current) return;
    voice.startListening(
      async (text) => {
        if (!inCallRef.current) return;
        await ask(text, true);
        if (inCallRef.current) callTurn();
      },
      { continuous: false },
    );
  }
  async function startCall() {
    inCallRef.current = true;
    setInCall(true);
    await voice.speak("Здравствуйте! Слушаю вас. Что проанализировать?");
    callTurn();
  }
  function endCall() {
    inCallRef.current = false;
    setInCall(false);
    voice.stopListening();
    voice.cancelSpeak();
  }

  // ── зажать и говорить ──
  function holdStart() {
    if (thinking || inCall) return;
    voice.cancelSpeak();
    voice.startListening((text) => ask(text, voiceOut), { continuous: true });
  }
  function holdEnd() {
    voice.stopListening();
  }

  const callStatus = voice.listening
    ? "слушаю…"
    : thinking
      ? "думаю…"
      : voice.speaking
        ? "говорю…"
        : "…";

  return (
    <section className="border-border bg-surface flex flex-col rounded-xl border">
      <div className="border-border flex items-center justify-between gap-3 border-b px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-accent-text text-base">✦</span>
          <h2 className="text-sm font-medium">ИИ-аналитик владельца</h2>
        </div>
        <label className="text-text-muted flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={voiceOut} onChange={(e) => setVoiceOut(e.target.checked)} />
          озвучивать ответы
        </label>
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

        {messages.length <= 1 && !inCall ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {OWNER_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s, voiceOut)}
                className="border-border text-text-muted hover:bg-hover rounded-md border px-2.5 py-1 text-xs"
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}

        {inCall ? (
          // Режим звонка — непрерывный разговор.
          <div className="border-border mt-3 flex items-center gap-4 rounded-xl border px-4 py-3">
            <span className="relative flex h-3 w-3 flex-none">
              <span className="bg-accent absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" />
              <span className="bg-accent relative inline-flex h-3 w-3 rounded-full" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Звонок с ассистентом · {callStatus}</div>
              <div className="text-text-subtle truncate text-xs">
                {voice.interimText || "говорите — я слушаю и отвечу голосом"}
              </div>
            </div>
            <button
              type="button"
              onClick={endCall}
              className="bg-accent text-accent-contrast hover:bg-accent-hover flex-none rounded-md px-3.5 py-2 text-sm font-medium"
            >
              Завершить
            </button>
          </div>
        ) : (
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              ask(input, voiceOut);
            }}
          >
            {voice.recognitionSupported ? (
              <button
                type="button"
                onPointerDown={holdStart}
                onPointerUp={holdEnd}
                onPointerLeave={() => voice.listening && holdEnd()}
                aria-label="Зажмите, чтобы говорить"
                title="Зажмите, чтобы говорить"
                className={`flex-none touch-none rounded-md border px-3 py-2 text-sm select-none ${
                  voice.listening
                    ? "border-accent bg-accent text-accent-contrast"
                    : "border-border text-text-muted hover:bg-hover"
                }`}
              >
                {voice.listening ? "● отпустите" : "🎤 зажать"}
              </button>
            ) : null}
            <input
              value={voice.listening ? voice.interimText : input}
              onChange={(e) => setInput(e.target.value)}
              readOnly={voice.listening}
              placeholder="Спросите или зажмите микрофон…"
              className="border-border-input bg-surface placeholder:text-text-subtle flex-1 rounded-md border px-3 py-2 text-sm outline-none"
            />
            {voice.recognitionSupported ? (
              <button
                type="button"
                onClick={startCall}
                className="border-accent-border bg-accent-tint text-accent-text hover:bg-accent hover:text-accent-contrast flex-none rounded-md border px-3 py-2 text-sm font-medium"
                title="Позвонить ассистенту — разговор голосом"
              >
                Позвонить
              </button>
            ) : null}
            <button
              type="submit"
              disabled={!input.trim() || thinking}
              className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-4 py-2 text-sm font-medium disabled:opacity-45"
            >
              Спросить
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
