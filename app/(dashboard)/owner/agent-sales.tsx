"use client";

import { useState } from "react";
import { formatMoney, formatNumber } from "@/lib/format";
import type { AgentSalesReport } from "@/lib/server/agent-sales";

/**
 * Что ассистент довёл до записи.
 *
 * Продажей считается доведённая до администратора заявка: ассистент сам
 * ответил на вопросы и собрал данные, человеку осталось поставить время.
 * Запись, которую от начала до конца оформил администратор, сюда не идёт —
 * иначе раздел приписывал бы себе весь поток клиники и всегда выглядел бы
 * успешным.
 *
 * Деньги — только у состоявшихся визитов: назначенный приём это план, а не
 * выручка (§8). Поэтому рядом с суммой всегда стоит, сколько заявок ещё
 * впереди.
 */
export function AgentSales({
  report,
  periodLabel,
}: {
  report: AgentSalesReport;
  periodLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const ahead = report.bookings - report.arrived;

  return (
    <section className="border-border bg-surface mt-4 rounded-xl border p-5">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-sm font-medium">Что ассистент довёл до записи</h2>
        <span className="text-text-subtle text-2xs">{periodLabel}</span>
        {report.bookings > 0 ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-accent-text ml-auto text-xs hover:underline"
          >
            Показать заявки
          </button>
        ) : null}
      </div>

      {report.bookings === 0 ? (
        <p className="text-text-muted mt-3 text-sm">
          За этот период ассистент не довёл до записи ни одной заявки. Считается только та, где
          он сам собрал данные и передал администратору готового пациента.
        </p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
            <Figure
              label="Заявок собрал"
              value={formatNumber(report.bookings)}
              hint="данные собрал ассистент, время поставил администратор"
            />
            <Figure
              label="Из них состоялось"
              value={formatNumber(report.arrived)}
              hint={ahead > 0 ? `ещё ${formatNumber(ahead)} впереди или не отмечены` : "все прошли"}
            />
            <Figure
              label="Деньги состоявшихся"
              value={formatMoney(report.revenue)}
              hint="назначенный приём — план, а не выручка"
            />
          </div>

          <h3 className="text-text-muted mt-5 mb-2 text-2xs">По услугам</h3>
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[420px] border-collapse text-sm">
              <thead>
                <tr className="text-text-subtle text-left text-2xs">
                  <th className="py-2 pr-3 font-normal">Услуга</th>
                  <th className="py-2 pr-3 text-right font-normal">Заявок</th>
                  <th className="py-2 pr-3 text-right font-normal">Пришли</th>
                  <th className="py-2 text-right font-normal">Деньги</th>
                </tr>
              </thead>
              <tbody>
                {report.byService.map((row) => (
                  <tr key={row.title} className="border-border-soft border-t">
                    <td className="py-2 pr-3">{row.title}</td>
                    <td className="num py-2 pr-3 text-right">{formatNumber(row.bookings)}</td>
                    <td className="num py-2 pr-3 text-right">{formatNumber(row.arrived)}</td>
                    <td className="num py-2 text-right">{formatMoney(row.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-text-subtle mt-2 text-2xs">
            У визита из нескольких услуг деньги делятся между ними поровну: в записи одна сумма, и
            разносить её по прайсу нельзя — фактическая цена с прайсом не обязана совпадать.
          </p>
        </>
      )}

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="border-border bg-surface max-h-[80vh] w-full max-w-[720px] overflow-auto rounded-xl border p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline gap-3">
              <h3 className="text-sm font-medium">Заявки, собранные ассистентом</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-text-subtle hover:text-text ml-auto text-sm"
              >
                Закрыть
              </button>
            </div>
            <p className="text-text-subtle mt-1 text-2xs">
              Здесь видно, что именно засчитано: разговор, услуга и деньги. Если строка выглядит
              чужой — значит правило засчитывания надо уточнить, а не число.
            </p>
            <table className="mt-3 w-full border-collapse text-sm">
              <thead>
                <tr className="text-text-subtle text-left text-2xs">
                  <th className="py-2 pr-3 font-normal">Пациент</th>
                  <th className="py-2 pr-3 font-normal">Услуга</th>
                  <th className="py-2 pr-3 font-normal">Когда</th>
                  <th className="py-2 text-right font-normal">Деньги</th>
                </tr>
              </thead>
              <tbody>
                {report.sales.map((s) => (
                  <tr key={s.appointmentId} className="border-border-soft border-t">
                    <td className="py-2 pr-3">{s.patientName ?? "без имени"}</td>
                    <td className="py-2 pr-3">{s.services.join(", ")}</td>
                    <td className="text-text-muted py-2 pr-3 text-xs">
                      {new Date(s.at).toLocaleDateString("ru-RU", {
                        day: "numeric",
                        month: "long",
                      })}
                    </td>
                    <td className="num py-2 text-right">
                      {s.arrived ? formatMoney(s.revenue) : "ещё не прошёл"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border-border bg-surface rounded-xl border px-4 py-3.5">
      <div className="text-text-subtle text-2xs">{label}</div>
      <div className="readout mt-1 text-xl">{value}</div>
      {hint ? <div className="text-text-subtle mt-0.5 text-2xs">{hint}</div> : null}
    </div>
  );
}
