"use client";

import { useMemo, useState } from "react";
import { AGENT_DOES, AGENT_DOES_NOT, ARTICLES, HINTS } from "@/lib/help/topics";
import { HOTKEYS } from "@/lib/inbox/hotkeys";

/**
 * Справочник по диалогам.
 *
 * В самих «Диалогах» по «?» открывается быстрая подсказка — одна строка на
 * задачу, чтобы не отрываться от работы. Здесь то же самое подробно: шаги,
 * что означают состояния переписки, что ассистент делает сам и чего не делает.
 * Быстрая подсказка отвечает «как», справочник — «как именно и почему».
 *
 * Тексты у обоих одни и те же (`lib/help/topics.ts`): две копии одного
 * объяснения расходятся на второй правке, и человек получает два разных
 * ответа на один вопрос.
 */
export function DialogsGuide() {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ARTICLES;
    return ARTICLES.filter((a) =>
      `${a.title} ${a.answer} ${(a.steps ?? []).join(" ")}`.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <section className="border-border bg-surface max-w-[900px] rounded-xl border p-5">
      <div className="mb-1 flex flex-wrap items-baseline gap-3">
        <h2 className="text-base font-medium">Справочник по диалогам</h2>
        <span className="text-text-subtle text-2xs">
          короткая подсказка — клавиша «?» прямо в переписке
        </span>
      </div>
      <p className="text-text-muted mb-3 text-sm leading-snug">
        Заголовок — задача, первая строка под ним — готовый ответ. Подробности раскрываются.
      </p>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Что нужно сделать? Например: шаблон, ночью, передать, выключить"
        className="border-border-input bg-surface placeholder:text-text-subtle mb-3 w-full rounded-md border px-3 py-2 text-sm outline-none"
      />

      <div className="flex flex-col gap-2">
        {found.length === 0 ? (
          <p className="text-text-muted text-sm">
            По этому слову ничего нет. Это дефект справочника, а не ваш: скажите, чего не
            хватило, — допишем.
          </p>
        ) : null}
        {found.map((a) => {
          const open = openId === a.id;
          return (
            <article key={a.id} className="border-border-soft rounded-lg border p-3">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : a.id)}
                className="flex w-full items-baseline gap-3 text-left"
              >
                <span className="text-sm font-medium">{a.title}</span>
                <span className="text-text-subtle ml-auto flex-none text-2xs">
                  {open ? "свернуть" : "подробнее"}
                </span>
              </button>
              <p className="text-text-muted mt-1 text-sm leading-snug">{a.answer}</p>
              {open ? (
                <div className="mt-2.5 flex flex-col gap-2">
                  {a.steps ? (
                    <ol className="text-text-muted flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-snug">
                      {a.steps.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ol>
                  ) : null}
                  {a.hints?.length ? (
                    <ul className="border-border-soft flex flex-col gap-1.5 border-t pt-2.5">
                      {a.hints.map((id) => {
                        const h = HINTS[id];
                        if (!h) return null;
                        return (
                          <li key={id} className="text-text-muted text-xs leading-snug">
                            <span className="text-text font-medium">{h.short}</span>
                            {h.long ? ` ${h.long}` : ""}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {/* Состояния переписки: их спрашивают чаще всего. */}
      <div className="border-border-soft mt-4 border-t pt-4">
        <div className="text-text-subtle mb-2 text-2xs">Что означают надписи в переписке</div>
        <ul className="flex flex-col gap-1.5">
          {["agentActive", "agentHuman", "agentPaused", "agentOff", "returnToBot", "callAdmin", "window24"].map(
            (id) => {
              const h = HINTS[id];
              if (!h) return null;
              return (
                <li key={id} className="text-text-muted text-sm leading-snug">
                  <span className="text-text font-medium">{h.short}</span>
                  {h.long ? ` ${h.long}` : ""}
                </li>
              );
            },
          )}
        </ul>
      </div>

      {/*
        Что ассистент делает, а что нет. Этот список снимает половину вопросов
        «почему бот не ответил»: границы установила клиника, и всё, что не в
        левом столбце, он отдаёт человеку намеренно.
      */}
      <div className="border-border-soft mt-4 border-t pt-4">
        <div className="text-text-subtle mb-2 text-2xs">Что умеет ассистент, а что нет</div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="text-text-subtle mb-1 text-2xs">отвечает сам</div>
            <ul className="text-text-muted flex list-disc flex-col gap-1 pl-4 text-sm leading-snug">
              {AGENT_DOES.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-text-subtle mb-1 text-2xs">отдаёт человеку</div>
            <ul className="text-text-muted flex list-disc flex-col gap-1 pl-4 text-sm leading-snug">
              {AGENT_DOES_NOT.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="border-border-soft mt-4 border-t pt-4">
        <div className="mb-2 flex flex-wrap items-baseline gap-3">
          <div className="text-text-subtle text-2xs">Клавиши</div>
          <button
            type="button"
            onClick={() => window.print()}
            className="border-border text-text-muted hover:bg-hover ml-auto rounded-md border px-2.5 py-1 text-xs"
          >
            Распечатать
          </button>
        </div>
        <ul className="flex flex-col gap-1.5">
          {HOTKEYS.map((h) => (
            <li key={h.keys} className="flex items-baseline gap-3 text-sm">
              <kbd className="num border-border text-text-muted w-[124px] flex-none rounded-sm border px-1.5 py-px text-2xs">
                {h.keys}
              </kbd>
              <span className="text-text-muted">{h.what}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
