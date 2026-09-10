"use client";

import { useMemo, useState } from "react";
import { AGENT_DOES, AGENT_DOES_NOT, ARTICLES, HINTS } from "@/lib/help/topics";
import { HOTKEYS } from "@/lib/inbox/hotkeys";

/**
 * Справка, построенная по задачам.
 *
 * Человек приходит с вопросом «как передать диалог коллеге», а не «что такое
 * инбокс», и раздел, названный именем экрана, заставляет его сначала угадать,
 * где живёт его задача. Поэтому заголовок каждой статьи — это задача, а первая
 * строка под ним — готовый ответ: его читают первым и часто единственным.
 *
 * Поиск ищет по заголовку, ответу и шагам сразу: человек помнит слово из
 * своей задачи («шаблон», «ночью», «выключить»), а не название статьи.
 */
export function HelpClient() {
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
    <div className="flex max-w-[860px] flex-col gap-5">
      <div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Что нужно сделать? Например: шаблон, ночью, передать, выключить"
          className="border-border-input bg-surface placeholder:text-text-subtle w-full rounded-md border px-3 py-2 text-sm outline-none"
        />
      </div>

      <section className="flex flex-col gap-2">
        {found.length === 0 ? (
          <p className="text-text-muted text-sm">
            По этому слову ничего нет. Спросите в чате клиники — и напишите нам, чего не хватило
            в справке: это её дефект, а не ваш.
          </p>
        ) : null}
        {found.map((a) => {
          const open = openId === a.id;
          return (
            <article key={a.id} className="border-border bg-surface rounded-xl border p-4">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : a.id)}
                className="flex w-full items-baseline gap-3 text-left"
              >
                <span className="text-base font-medium">{a.title}</span>
                <span className="text-text-subtle ml-auto flex-none text-2xs">
                  {open ? "свернуть" : "подробнее"}
                </span>
              </button>
              {/* Ответ виден всегда: он и есть справка для большинства случаев. */}
              <p className="text-text-muted mt-1.5 text-sm leading-snug">{a.answer}</p>
              {open ? (
                <div className="mt-3 flex flex-col gap-2">
                  {a.steps ? (
                    <ol className="text-text-muted flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-snug">
                      {a.steps.map((s) => (
                        <li key={s}>{s}</li>
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
      </section>

      {/*
        Что ассистент делает, а что нет. Отдельным блоком, потому что этот
        список снимает половину вопросов «почему бот не ответил».
      */}
      <section className="border-border bg-surface rounded-xl border p-5">
        <h2 className="text-base font-medium">Что умеет ассистент, а что нет</h2>
        <p className="text-text-muted mt-1 text-sm leading-snug">
          Границы установила клиника. Всё, что не в левом столбце, ассистент отдаёт человеку —
          это не поломка, а правило.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <div className="text-text-subtle mb-1.5 text-2xs">Отвечает сам</div>
            <ul className="text-text-muted flex list-disc flex-col gap-1 pl-4 text-sm leading-snug">
              {AGENT_DOES.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-text-subtle mb-1.5 text-2xs">Отдаёт человеку</div>
            <ul className="text-text-muted flex list-disc flex-col gap-1 pl-4 text-sm leading-snug">
              {AGENT_DOES_NOT.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Шпаргалка — та же, что открывается по «?» в диалогах. Печатается на страницу. */}
      <section className="border-border bg-surface rounded-xl border p-5 print:break-inside-avoid">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-base font-medium">Горячие клавиши</h2>
          <span className="text-text-subtle text-2xs">в диалогах открывается по «?»</span>
          <button
            type="button"
            onClick={() => window.print()}
            className="border-border text-text-muted hover:bg-hover ml-auto rounded-md border px-2.5 py-1 text-xs"
          >
            Распечатать
          </button>
        </div>
        <ul className="mt-3 flex flex-col gap-1.5">
          {HOTKEYS.map((h) => (
            <li key={h.keys} className="flex items-baseline gap-3 text-sm">
              <kbd className="num border-border text-text-muted w-[124px] flex-none rounded-sm border px-1.5 py-px text-2xs">
                {h.keys}
              </kbd>
              <span className="text-text-muted">{h.what}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="border-border bg-surface rounded-xl border p-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-base font-medium">Знакомство с платформой</h2>
          <span className="text-text-muted text-sm">
            Семь шагов с подсветкой прямо в интерфейсе.
          </span>
          <button
            type="button"
            onClick={() => {
              /**
               * Тур подсвечивает настоящие элементы, а большая их часть живёт
               * в «Диалогах». Отсюда уводим туда сами — иначе человек нажмёт
               * и не увидит ничего.
               */
              window.location.href = "/inbox?tour=1";
            }}
            className="bg-accent text-accent-contrast ml-auto rounded-md px-3 py-1.5 text-xs font-medium"
          >
            Пройти заново
          </button>
        </div>
      </section>
    </div>
  );
}
