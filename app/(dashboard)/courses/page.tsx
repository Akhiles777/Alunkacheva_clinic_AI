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
  if (c.booked > 0) parts.push(`записан ещё на ${c.booked}`);
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
          Список отсортирован по неотработанной сумме. «Написать» открывает диалог, не
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
            Пустота, у которой есть причина, должна её называть. Раньше причина
            была одна — курсов не существовало нигде. Теперь они собираются из
            записей, и пусто может быть по двум разным поводам: услуга не
            отмечена курсовой либо оплаты курса нет в записях.
          */
          <div className="border-border bg-surface max-w-[560px] rounded-xl border p-5">
            <p className="text-md font-medium">Курсов пока нет</p>
            <p className="text-text-muted mt-2 text-sm leading-relaxed">
              Курс собирается из записей YCLIENTS: оплаченный визит открывает его, следующие
              сеансы с нулевой стоимостью к нему прикрепляются. Поэтому пусто здесь бывает по двум
              причинам: услуга не отмечена курсовой в «Настройки → Услуги» либо оплаты курса нет в
              записях — тогда сеансы считаются просто бесплатными.
            </p>
            <p className="text-text-subtle mt-2 text-sm leading-relaxed">
              Новых денег курс не создаёт: его сумма — это стоимость записи дня продажи, уже
              учтённая в выручке того дня. Он нужен, чтобы объяснить нули у остальных сеансов.
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
                  {/*
                    «Осталось» — про НЕзаписанные сеансы: это число отвечает на
                    вопрос «кого звать». Записанные впереди называем отдельно,
                    иначе экран зовёт пациента, у которого оставшиеся приёмы уже
                    стоят в расписании.
                  */}
                  <div className="num text-text-subtle mt-1 text-2xs">
                    {c.used}/{c.total}
                    {c.booked > 0 ? ` · записан ещё на ${c.booked}` : ""}
                    {c.toBook > 0 ? ` · дозаписать ${c.toBook}` : ""}
                  </div>
                </div>

                <div className="num w-24 flex-none text-right text-sm max-md:flex max-md:w-full max-md:items-baseline max-md:justify-between max-md:text-left">
                  <span>{formatMoney(c.moneyLeft)}</span>
                  <span className="text-text-subtle text-2xs">оплачено, не отработано</span>
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
          // Пишем про НЕзаписанные сеансы: предлагать запись человеку, у
          // которого приём уже назначен, — повод для недоумения.
          prefillMessage={`Здравствуйте! У вас остались сеансы курса «${writeTo.title}» (${writeTo.toBook} из ${writeTo.total}). Записать вас на следующий?`}
        />
      ) : null}
    </>
  );
}
