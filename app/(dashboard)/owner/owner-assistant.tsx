"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { askAI } from "../_components/assistant-actions";
import { aiFailureText } from "@/lib/assistant/failure";
import { Spinner } from "../_components/page-skeleton";
import { getOwnerAiContext } from "./actions";
import {
  appendAiTurn,
  deleteAiChat,
  getAiChat,
  listAiChats,
  renameAiChat,
  type AiChatSummary,
} from "./chat-actions";

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
    "Я ваш личный бизнес-аналитик. Вижу базу целиком: воронку и обращения по источникам, выручку и " +
    "приёмы по специалистам, загрузку кабинетов, удержание, отмены и неявки — за неделю, месяц, " +
    "квартал и по месяцам за год. Спросите текстом — отвечу разбором по цифрам.",
};

/**
 * ИИ-аналитик владельца с сохранёнными разборами.
 *
 * Раньше разговор жил до перезагрузки страницы: владелец спрашивал «где мы
 * теряем деньги», получал анализ и терял его вместе со вкладкой. Теперь слева
 * список разборов, и каждый — своя задача.
 *
 * Только текст. Озвучивание и режим звонка убраны намеренно (решение
 * заказчика, август 2026): владелец читает разбор, а не слушает его. Голос
 * остаётся в чате сотрудников как голосовые сообщения.
 */
export function OwnerAssistant() {
  const [chats, setChats] = useState<AiChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [opening, setOpening] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const reloadList = useCallback(() => {
    listAiChats()
      .then(setChats)
      .catch(() => {
        // Список — не разговор: без него можно спрашивать дальше.
      });
  }, []);

  useEffect(() => {
    reloadList();
  }, [reloadList]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  async function openChat(id: string) {
    setChatId(id);
    setOpening(true);
    try {
      const turns = await getAiChat(id);
      setMessages(turns.length > 0 ? turns : [WELCOME]);
    } catch {
      setMessages([WELCOME]);
    }
    setOpening(false);
  }

  function newChat() {
    setChatId(null);
    setMessages([WELCOME]);
    setInput("");
  }

  async function ask(text: string) {
    const q = text.trim();
    if (!q || thinking) return;
    /**
     * В модель уходят только последние реплики. Полная история отправлялась
     * целиком, и счёт рос с каждым вопросом — при этом старые ответы новому
     * вопросу почти не нужны. В базе при этом хранится всё.
     */
    const history = messages
      .filter((m) => m !== WELCOME)
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.text.slice(0, 1500) }));
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setThinking(true);
    let answer = "";
    try {
      const context = await getOwnerAiContext();
      const res = await askAI(q, context, history, "owner");
      /**
       * Не ответил — так и говорим.
       *
       * Здесь стояла подмена: не получилось у модели — отвечал локальный
       * движок по правилам. Владелец спрашивал «как повысить выручку» и
       * получал сводку по случайному пациенту, а следом «скоро подключим
       * полноценный ИИ» — уверенный ответ не на его вопрос. Это хуже
       * молчания: по такому ответу нельзя понять, что разбора не было.
       */
      answer = res.text ?? aiFailureText(res.error);
    } catch (e) {
      answer = aiFailureText(e instanceof Error ? e.name : "unknown");
    }
    setMessages((m) => [...m, { role: "assistant", text: answer }]);
    setThinking(false);

    try {
      const saved = await appendAiTurn({ chatId, question: q, answer });
      setChatId(saved.chatId);
      reloadList();
    } catch {
      // Ответ уже на экране. Не сохранился — это неприятно, но не повод
      // прятать разбор, который человек только что получил.
    }
  }

  async function remove(id: string) {
    await deleteAiChat(id).catch(() => {});
    if (id === chatId) newChat();
    reloadList();
  }

  async function commitRename(id: string) {
    const title = draftTitle.trim();
    setRenaming(null);
    if (title.length === 0) return;
    await renameAiChat(id, title).catch(() => {});
    reloadList();
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

      {/*
        На телефоне высота не фиксируется.

        Раньше здесь стояло `h-[min(60vh,540px)]` и на узком экране обе панели
        складывались друг под друга ВНУТРИ этой высоты: список разборов,
        подсказки и поле ввода съедали её почти целиком, и на сам разбор
        оставалось две строки. Именно так «сломалась адаптивность»: экран не
        уезжал, он схлопывался.
      */}
      <div className="flex h-[min(60vh,540px)] min-h-0 max-md:h-auto max-md:flex-col">
        {/* Список разборов. Каждый — своя задача, к которой можно вернуться. */}
        <aside className="border-border flex w-[210px] flex-none flex-col border-r max-md:w-full max-md:border-r-0 max-md:border-b">
          <button
            type="button"
            onClick={newChat}
            className="border-border-soft text-accent-text hover:bg-accent-tint border-b px-4 py-2.5 text-left text-xs font-medium transition-colors"
          >
            + Новый разбор
          </button>
          <div className="flex-1 overflow-auto max-md:max-h-[104px]">
            {chats.length === 0 ? (
              <p className="text-text-subtle px-4 py-3 text-2xs leading-relaxed">
                Сохранённых разборов пока нет. Задайте вопрос — разговор сохранится сам и будет
                здесь.
              </p>
            ) : (
              <ul>
                {chats.map((c) => (
                  <li key={c.id} className="group relative">
                    {renaming === c.id ? (
                      <input
                        autoFocus
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onBlur={() => commitRename(c.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(c.id);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        className="border-border-input bg-surface m-1.5 w-[calc(100%-12px)] rounded-md border px-2 py-1 text-xs outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => openChat(c.id)}
                        onDoubleClick={() => {
                          setRenaming(c.id);
                          setDraftTitle(c.title);
                        }}
                        title="Двойной щелчок — переименовать"
                        className={`block w-full px-4 py-2 pr-8 text-left transition-colors ${
                          c.id === chatId ? "bg-nav-active" : "hover:bg-hover"
                        }`}
                      >
                        <span className="text-text block truncate text-xs">{c.title}</span>
                        <span className="text-text-subtle text-2xs">
                          {c.at} · {c.messages} сообщ.
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(c.id)}
                      aria-label={`Удалить разбор «${c.title}»`}
                      className="text-text-subtle hover:text-accent-text absolute top-2 right-2 hidden text-xs group-hover:block"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-5 py-4 max-md:px-4">
          {/* Разбору нужна собственная высота: на телефоне он главное на экране. */}
          <div className="flex-1 space-y-3 overflow-auto pr-1 max-md:min-h-[48vh]">
            {opening ? (
              <div className="flex h-full items-center justify-center">
                <Spinner label="Открываем разбор" />
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-line ${
                      m.role === "user" ? "bg-accent text-accent-contrast" : "bg-hover text-text"
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))
            )}
            {thinking ? (
              <div className="flex justify-start">
                <div className="bg-hover flex items-center gap-2 rounded-2xl px-3.5 py-2">
                  <span className="spinner spinner-sm" aria-hidden />
                  <span className="text-text-subtle text-sm">думаю…</span>
                </div>
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          {messages.length <= 1 && !opening ? (
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
      </div>
    </section>
  );
}
