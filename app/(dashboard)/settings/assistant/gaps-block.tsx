"use client";

import { useState } from "react";
import { Group } from "../_components/ui";

/**
 * «Пробелы в справочнике» — о чём пациенты спрашивают, а ответить нечем.
 *
 * Экран ничего не считает и ничего не создаёт. Он показывает сгруппированные
 * вопросы, оставшиеся без ответа, и рядом — то, чем на них ответил
 * администратор в переписке.
 *
 * Кнопка «Создать запись из этого ответа» НЕ создаёт запись. Она добавляет
 * черновик в редактор базы знаний ниже: человек читает текст, правит его под
 * ответ всем, а не одному пациенту, и только потом жмёт «Сохранить». Разница
 * не косметическая. Администратор пишет конкретному человеку, зная его случай
 * («вам с вашим давлением лучше не надо») — как справка такой текст опасен, а
 * автоматический перенос сделал бы его справкой молча.
 */

export interface GapAnswerView {
  text: string;
  at: string;
  authorName: string | null;
}

export interface GapView {
  key: string;
  title: string;
  count: number;
  lastAt: string;
  reasons: string[];
  medical: boolean;
  questions: { id: string; text: string; at: string }[];
  answers: GapAnswerView[];
}

export interface GapsData {
  clusters: GapView[];
  total: number;
  withoutQuestion: number;
  windowDays: number;
}

const REASON_LABEL: Record<string, string> = {
  MISUNDERSTOOD: "не понял вопрос",
  MEDICAL_QUESTION: "медицинский вопрос",
};

const day = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  timeZone: "Europe/Moscow",
});

export interface GapDraft {
  topic: string;
  question: string;
  answer: string;
  medical: boolean;
}

export function GapsBlock({
  data,
  onDraft,
}: {
  data: GapsData;
  onDraft: (draft: GapDraft) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [drafted, setDrafted] = useState<string | null>(null);

  return (
    <Group
      title="Пробелы в справочнике"
      hint={`вопросы без ответа за ${data.windowDays} дней`}
    >
      {data.clusters.length === 0 ? (
        <p className="text-text-muted text-sm">
          {data.total === 0
            ? "За этот срок ассистент ни разу не остался без ответа: эскалаций «не понял вопрос» и «медицинский вопрос» не было."
            : "Вопросы к этим эскалациям не нашлись: переписки за срок нет."}
        </p>
      ) : (
        <>
          <p className="text-text-muted text-sm leading-relaxed">
            Похожие вопросы собраны в группы. Ответ администратора рядом — это{" "}
            <b>черновик</b>, а не готовая справка: он писал одному человеку, зная его случай.
            Проверьте текст, прежде чем сохранять.
          </p>

          <ul className="flex flex-col gap-2">
            {data.clusters.map((c) => {
              const expanded = open === c.key;
              return (
                <li key={c.key} className="border-border rounded-lg border">
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : c.key)}
                    className="hover:bg-hover flex w-full items-baseline gap-3 rounded-lg px-3 py-2.5 text-left"
                  >
                    <span className="num text-text-muted w-8 flex-none text-sm">×{c.count}</span>
                    <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
                    {c.medical ? (
                      <span
                        className="text-accent-text flex-none text-2xs"
                        title="Медицинская тема: справку по ней утверждает врач, а не администратор."
                      >
                        нужен врач
                      </span>
                    ) : null}
                    <span className="text-text-subtle flex-none text-2xs">
                        {day.format(new Date(c.lastAt))}
                    </span>
                  </button>

                  {expanded ? (
                    <div className="border-border-soft flex flex-col gap-3 border-t px-3 py-3">
                      <div>
                        <div className="text-text-subtle mb-1 text-2xs">
                          Как спрашивали ({c.reasons.map((r) => REASON_LABEL[r] ?? r).join(", ")})
                        </div>
                        <ul className="flex flex-col gap-1">
                          {c.questions.slice(0, 5).map((q) => (
                            <li key={q.id} className="text-sm">
                              <span className="num text-text-subtle mr-2 text-2xs">
                                {day.format(new Date(q.at))}
                              </span>
                              {q.text}
                            </li>
                          ))}
                          {c.questions.length > 5 ? (
                            <li className="text-text-subtle text-2xs">
                              и ещё {c.questions.length - 5}
                            </li>
                          ) : null}
                        </ul>
                      </div>

                      {c.medical ? (
                        <p className="text-text-muted text-2xs leading-relaxed">
                          Медицинская тема. Ассистент отвечает такими текстами дословно, поэтому
                          запись создаётся выключенной и включается только после утверждения
                          врачом.
                        </p>
                      ) : null}

                      {c.answers.length === 0 ? (
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="text-text-subtle text-2xs">
                            Ответа сотрудника в переписке не нашлось — текст придётся написать.
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              onDraft({ topic: c.title, question: c.title, answer: "", medical: c.medical });
                              setDrafted(c.key);
                            }}
                            className="border-border text-text-muted hover:bg-hover rounded-md border px-2.5 py-1 text-2xs"
                          >
                            Создать пустую запись
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <div className="text-text-subtle text-2xs">Чем отвечали люди</div>
                          {c.answers.slice(0, 3).map((a, i) => (
                            <div key={i} className="border-border-soft rounded-md border px-2.5 py-2">
                              <div className="text-text-subtle mb-1 text-2xs">
                                {day.format(new Date(a.at))}
                                {a.authorName ? ` · ${a.authorName}` : ""}
                              </div>
                              <div className="text-sm whitespace-pre-wrap">{a.text}</div>
                              <button
                                type="button"
                                onClick={() => {
                                  onDraft({
                                    topic: c.title,
                                    question: c.title,
                                    answer: a.text,
                                    medical: c.medical,
                                  });
                                  setDrafted(c.key);
                                }}
                                className="border-border text-text-muted hover:bg-hover mt-2 rounded-md border px-2.5 py-1 text-2xs"
                              >
                                Создать запись из этого ответа
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {drafted === c.key ? (
                        <p className="text-accent-text text-2xs">
                          Черновик добавлен в базу знаний ниже. Проверьте текст и нажмите
                          «Сохранить» — до этого запись не существует.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {data.withoutQuestion > 0 ? (
            <p className="text-text-subtle text-2xs">
              Ещё {data.withoutQuestion} эскалаций без вопроса пациента: переписки к ним не
              нашлось. В группы они не попали и числом не размазаны.
            </p>
          ) : null}
        </>
      )}
    </Group>
  );
}
