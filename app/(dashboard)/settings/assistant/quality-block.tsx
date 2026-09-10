"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Group } from "../_components/ui";
import { VERDICT_LABEL, type Verdict } from "@/lib/metrics/quality-sample";
import { reviewQualityCheck } from "./quality-actions";
import type { GapDraft } from "./gaps-block";

/**
 * «Контроль качества ответов» — что проверка нашла и что с этим сделал человек.
 *
 * Экран ничего не решает сам. Вердикт вынесла модель, и она ошибается: назвала
 * отклонением дословную справку, не увидела прошлых реплик. Поэтому у каждой
 * строки две равноправные кнопки — «Это ошибка» и «Ответ верный», — и вторая
 * не спрятана и не подписана мельче первой. Число подтверждённых стоит рядом с
 * числом отклонённых: если проверка ошибается чаще, чем агент, это должно быть
 * видно сразу, а не выясняться через месяц.
 *
 * Запись справочника отсюда не создаётся автоматически — ровно как в
 * «Пробелах»: кнопка кладёт ЧЕРНОВИК в редактор ниже, а сохраняет человек.
 */

export interface QualityProblemView {
  id: string;
  verdict: string;
  comment: string;
  reason: string;
  at: string;
  question: string;
  answer: string;
  conversationId: string;
}

export interface QualityData {
  problems: QualityProblemView[];
  checked: number;
  totalProblems: number;
  confirmed: number;
  rejected: number;
  since: string | null;
  /** Проверка идёт только в это время — иначе «ничего нет» читается как поломка. */
  window: string;
}

/** Почему ответ попал в выборку. Основание видно у каждой строки (§9). */
const REASON_LABEL: Record<string, string> = {
  medical: "медицинская тема",
  escalated: "после ответа позвали человека",
  reasked: "пациент переспросил",
  ungrounded: "ответ без записи справочника",
  random: "случайная выборка",
};

const day = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  timeZone: "Europe/Moscow",
});

/**
 * Дата внутри фразы — полным месяцем: короткий формат в русском кончается
 * точкой, и «с 10 сент..» на экране выглядит опечаткой платформы.
 */
const dayInText = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  timeZone: "Europe/Moscow",
});

/** По каким вердиктам осмысленно заводить справку: агенту нечем было ответить. */
const NEEDS_ENTRY = new Set(["MEDICAL_WITHOUT_SOURCE", "UNSUPPORTED_CLAIM"]);

export function QualityBlock({
  data,
  onDraft,
}: {
  data: QualityData;
  onDraft: (draft: GapDraft) => void;
}) {
  const [problems, setProblems] = useState(data.problems);
  /** Счётчики живут рядом со списком и меняются вместе с ним. */
  const [stats, setStats] = useState({
    checked: data.checked,
    total: data.totalProblems,
    confirmed: data.confirmed,
    rejected: data.rejected,
    since: data.since,
  });
  const [open, setOpen] = useState<string | null>(null);
  const [drafted, setDrafted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const review = (id: string, confirmed: boolean) => {
    setError(null);
    start(async () => {
      try {
        const next = await reviewQualityCheck(id, confirmed);
        setProblems(next.problems);
        setStats({
          checked: next.summary.checked,
          total: next.summary.problems,
          confirmed: next.summary.confirmed,
          rejected: next.summary.rejected,
          since: next.summary.since,
        });
      } catch (e) {
        setError((e as Error)?.message || "Не удалось сохранить решение");
      }
    });
  };

  return (
    <Group title="Контроль качества ответов" hint={`проверка ночью, ${data.window}`}>
      {stats.checked === 0 ? (
        <p className="text-text-muted text-sm leading-relaxed">
          Проверок ещё не было. Раз в неделю выборка ответов ассистента сверяется с записями
          справочника, на которые он ссылался: медицинские темы берутся все, остальные — выборочно.
          Пока ассистент не ответил ни разу или ночной прогон ещё не проходил, здесь пусто — это не
          признак того, что всё хорошо.
        </p>
      ) : (
        <p className="text-text-muted text-sm leading-relaxed">
          Проверено ответов: <b className="num">{stats.checked}</b>
          {stats.since ? ` с ${dayInText.format(new Date(stats.since))}` : ""}. Замечаний:{" "}
          <b className="num">{stats.total}</b>. Из разобранных человеком подтверждено{" "}
          <b className="num">{stats.confirmed}</b>, отклонено <b className="num">{stats.rejected}</b>{" "}
          — отклонённые это ошибки самой проверки, а не ассистента.
        </p>
      )}

      {problems.length === 0 ? (
        stats.checked > 0 ? (
          <p className="text-text-subtle text-2xs">Неразобранных замечаний нет.</p>
        ) : null
      ) : (
        <ul className="flex flex-col gap-2">
          {problems.map((p) => {
            const expanded = open === p.id;
            const label = VERDICT_LABEL[p.verdict as Verdict] ?? p.verdict;
            return (
              <li key={p.id} className="border-border rounded-lg border">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : p.id)}
                  className="hover:bg-hover flex w-full items-baseline gap-3 rounded-lg px-3 py-2.5 text-left"
                >
                  <span className="text-accent-text flex-none text-2xs">{label}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{p.comment || p.question}</span>
                  <span className="text-text-subtle flex-none text-2xs">
                    {day.format(new Date(p.at))}
                  </span>
                </button>

                {expanded ? (
                  <div className="border-border-soft flex flex-col gap-3 border-t px-3 py-3">
                    <div>
                      <div className="text-text-subtle mb-1 text-2xs">Спросили</div>
                      <div className="text-sm whitespace-pre-wrap">{p.question}</div>
                    </div>
                    <div>
                      <div className="text-text-subtle mb-1 text-2xs">Ответил ассистент</div>
                      <div className="text-sm whitespace-pre-wrap">{p.answer}</div>
                    </div>
                    <div>
                      <div className="text-text-subtle mb-1 text-2xs">
                        Что заметила проверка · взят на проверку: {REASON_LABEL[p.reason] ?? p.reason}
                      </div>
                      <div className="text-sm">{p.comment || "без пояснения"}</div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => review(p.id, true)}
                        className="border-border text-text-muted hover:bg-hover rounded-md border px-2.5 py-1 text-2xs disabled:opacity-50"
                      >
                        Это ошибка
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => review(p.id, false)}
                        className="border-border text-text-muted hover:bg-hover rounded-md border px-2.5 py-1 text-2xs disabled:opacity-50"
                      >
                        Ответ верный
                      </button>
                      {NEEDS_ENTRY.has(p.verdict) ? (
                        <button
                          type="button"
                          onClick={() => {
                            onDraft({
                              topic: p.question.slice(0, 80),
                              question: p.question,
                              answer: "",
                              medical: p.verdict === "MEDICAL_WITHOUT_SOURCE",
                            });
                            setDrafted(p.id);
                          }}
                          className="border-border text-text-muted hover:bg-hover rounded-md border px-2.5 py-1 text-2xs"
                        >
                          Завести справку на этот вопрос
                        </button>
                      ) : null}
                      <Link
                        href={`/inbox?d=${encodeURIComponent(p.conversationId)}`}
                        className="text-accent-text text-2xs underline-offset-2 hover:underline"
                      >
                        Открыть переписку
                      </Link>
                    </div>

                    {drafted === p.id ? (
                      <p className="text-accent-text text-2xs">
                        Черновик добавлен в базу знаний ниже. Текст надо написать самим и нажать
                        «Сохранить» — до этого записи не существует.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {error ? <p className="text-danger-text text-2xs">{error}</p> : null}
    </Group>
  );
}
