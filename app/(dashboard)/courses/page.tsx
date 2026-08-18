"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { allCourses, setCourseBooked, useDb, type CourseView } from "@/app/_data/store";
import { formatMoney } from "@/lib/format";
import { ComposeOverlay } from "../_components/compose-overlay";

const FILTERS = [
  { id: "stalled", label: "Выпали из графика" },
  { id: "finish", label: "На финише" },
  { id: "active", label: "Активные" },
  { id: "done", label: "Завершённые" },
];

function matches(c: CourseView, filter: string): boolean {
  if (filter === "stalled") return c.stalled;
  if (filter === "finish") return c.onFinish;
  if (filter === "active") return c.status === "active";
  if (filter === "done") return c.status === "done";
  return true;
}

function reasonLine(c: CourseView): string {
  const parts = [`сеанс ${c.used} из ${c.total}`];
  if (c.daysAgo !== null) {
    parts.push(c.daysAgo === 0 ? "визит сегодня" : `последний визит ${c.daysAgo} дней назад`);
  }
  if (!c.hasFuture) parts.push("будущих записей нет");
  return parts.join(" · ");
}

export default function CoursesPage() {
  const db = useDb();
  const [filter, setFilter] = useState("stalled");
  const [writeTo, setWriteTo] = useState<CourseView | null>(null);

  const rows = useMemo(() => {
    return allCourses(db.patients)
      .filter((c) => matches(c, filter))
      .sort((a, b) => b.moneyLeft - a.moneyLeft);
  }, [db.patients, filter]);

  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Курсы</h1>
        <p className="text-text-muted mt-1.5 max-w-[70ch] text-xs leading-relaxed max-md:hidden">
          Выпавшие из графика — потерянные деньги: курс идёт, а будущей записи нет.
          Список отсортирован по деньгам в остатке. «Написать» открывает диалог, не
          уводя со страницы; из списка убирает только реальная будущая запись.
        </p>
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`rounded-md px-2.5 py-1 text-xs ${
                filter === f.id ? "bg-nav-active text-accent-text font-medium" : "text-text-muted hover:bg-hover"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-auto px-7 py-5 max-md:px-5">
        {rows.length === 0 ? (
          /*
            Курсы не заводит ни выгрузка YCLIENTS, ни интерфейс — их просто
            неоткуда взять. Пустая страница без объяснения читается как
            «данные не доехали», и это уже спрашивали про «Курсовые 0» в
            отчётах. Пустота, у которой есть причина, должна её называть.
          */
          <div className="border-border bg-surface max-w-[560px] rounded-xl border p-5">
            <p className="text-md font-medium">Курсов пока нет</p>
            <p className="text-text-muted mt-2 text-sm leading-relaxed">
              Курс — это оплаченная программа из нескольких сеансов. Из YCLIENTS такие продажи не
              приходят: там визит и оплата не связаны в программу, поэтому завести курс может
              только клиника — и такой возможности в платформе ещё нет.
            </p>
            <p className="text-text-subtle mt-2 text-sm leading-relaxed">
              Пока раздел пустой не потому, что данные не доехали, а потому, что их источника не
              существует. Повторные визиты при этом считаются как обычно — в «Отчётах».
            </p>
          </div>
        ) : (
          <ul className="border-border overflow-hidden rounded-xl border">
            {rows.map((c) => (
              <li
                key={`${c.patientId}-${c.courseId}`}
                className="border-border-soft flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b px-4 py-3 last:border-b-0 max-md:flex-col max-md:items-stretch"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <Link href={`/patients/${c.patientId}`} className="truncate text-sm font-medium hover:underline">
                      {c.patientName}
                    </Link>
                    {c.stalled ? (
                      <span className="text-accent-text text-2xs font-medium">выпал</span>
                    ) : c.onFinish ? (
                      <span className="text-text-subtle text-2xs">на финише</span>
                    ) : null}
                  </div>
                  <div className="text-text-muted mt-0.5 truncate text-xs">{c.title}</div>
                  <div className="text-text-subtle mt-0.5 text-2xs">{reasonLine(c)}</div>
                </div>

                <div className="w-28 flex-none max-md:w-full">
                  <div className="bg-list-gap h-1.5 overflow-hidden rounded-pill">
                    <div
                      className="bg-accent h-full rounded-pill"
                      style={{ width: `${Math.round((c.used / c.total) * 100)}%` }}
                    />
                  </div>
                  <div className="num text-text-subtle mt-1 text-2xs">
                    {c.used}/{c.total} · осталось {c.remaining}
                  </div>
                </div>

                <div className="num w-24 flex-none text-right text-sm max-md:flex max-md:w-full max-md:items-baseline max-md:justify-between max-md:text-left">
                  <span>{formatMoney(c.moneyLeft)}</span>
                  <span className="text-text-subtle text-2xs">в остатке</span>
                </div>

                <div className="flex flex-none gap-2 max-md:w-full">
                  <button
                    type="button"
                    onClick={() => setWriteTo(c)}
                    className="bg-accent text-accent-contrast hover:bg-accent-hover rounded-md px-3 py-1.5 text-sm font-medium max-md:flex-1 max-md:py-2.5"
                  >
                    Написать
                  </button>
                  {c.stalled ? (
                    <button
                      type="button"
                      onClick={() => setCourseBooked(c.patientId, c.courseId)}
                      className="border-border text-text-muted hover:bg-hover rounded-md border px-3 py-1.5 text-sm max-md:flex-1 max-md:py-2.5"
                      title="Отметить, что появилась будущая запись"
                    >
                      Записан
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {writeTo ? (
        <ComposeOverlay
          onClose={() => setWriteTo(null)}
          prefillPatientId={writeTo.patientId}
          prefillChannel={writeTo.channel === "instagram" ? "instagram" : "whatsapp"}
          prefillMessage={`Здравствуйте! У вас остались сеансы курса «${writeTo.title}» (${writeTo.remaining} из ${writeTo.total}). Записать вас на следующий?`}
        />
      ) : null}
    </>
  );
}
