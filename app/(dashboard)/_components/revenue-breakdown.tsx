"use client";

import { useEffect } from "react";
import { formatMoney } from "@/lib/format";
import type { Appt } from "@/app/_data/store";
import type { CourseSaleRow } from "../courses/actions";

/**
 * Из чего сложилась выручка дня.
 *
 * Число на экране отвечало «сколько», но не «откуда». Первый же вопрос
 * владельца после «сегодня 43 480 ₽» — «а из чего это», и до сих пор ответ
 * приходилось искать в отчётах другим экраном. Список открывается по нажатию
 * на саму сумму: он про тот же день и те же визиты, что и число над ним.
 *
 * Показываем ВСЕ состоявшиеся приёмы, а не только платные. Приём за ноль —
 * такая же операция дня: подарок по скидке, сеанс оплаченного курса или приём,
 * за который клиника денег не брала. Спрятать их значило бы ответить на вопрос
 * «из чего сложилась выручка» наполовину.
 *
 * Но и называть их «без оплаты» нельзя. За сеанс курса клиника получила деньги
 * — при продаже курса; ноль стоит в записи дня, а не в кассе. Подпись читалась
 * как ошибка платформы, а была неправдой о деньгах клиники. Каждый ноль теперь
 * называет свою причину.
 */
export function RevenueBreakdown({
  appts,
  sales,
  dateLabel,
  onClose,
}: {
  appts: Appt[];
  /** Курсы, проданные в этот день: их деньги — выручка того же дня. */
  sales: CourseSaleRow[];
  dateLabel: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * Приёмы и продажи курсов в одном списке, по времени.
   *
   * Продажа курса — операция дня наравне с приёмом: деньги пришли тогда же.
   * Держать её отдельно значило бы заставить складывать два списка глазами.
   */
  type Row =
    | { kind: "visit"; at: number; appt: Appt }
    | { kind: "sale"; at: number; sale: CourseSaleRow };
  const rows: Row[] = [
    ...appts
      .filter((a) => a.status === "arrived")
      .map((a) => ({ kind: "visit" as const, at: a.startMinute, appt: a })),
    ...sales.map((s) => ({ kind: "sale" as const, at: s.startMinute, sale: s })),
  ].sort((a, b) => a.at - b.at);

  const visits = rows.filter((r): r is Extract<Row, { kind: "visit" }> => r.kind === "visit");
  const total =
    visits.reduce((sum, r) => sum + (r.appt.price ?? 0), 0) +
    sales.reduce((sum, s) => sum + s.amount, 0);
  const byCourse = visits.filter(
    (r) => (r.appt.price ?? 0) === 0 && r.appt.amountSource === "PREPAID",
  ).length;
  const free = visits.filter(
    (r) => (r.appt.price ?? 0) === 0 && r.appt.amountSource !== "PREPAID",
  ).length;
  const notes = [
    byCourse > 0 ? `по курсу ${byCourse}` : null,
    free > 0 ? `бесплатно ${free}` : null,
  ].filter(Boolean);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center p-4 sm:p-8">
      <button
        type="button"
        aria-label="Закрыть"
        onClick={onClose}
        className="overlay-scrim absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-label={`Операции за ${dateLabel}`}
        className="border-border bg-surface day-pop relative flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-xl border shadow-lg"
      >
        <div className="border-border flex items-baseline justify-between gap-3 border-b px-5 py-3.5">
          <div>
            <h2 className="text-sm font-medium">Операции за {dateLabel}</h2>
            <p className="text-text-subtle mt-0.5 text-2xs">
              состоявшихся приёмов {visits.length}
              {notes.length > 0 ? `, из них ${notes.join(", ")}` : ""}
              {sales.length > 0 ? ` · продано курсов ${sales.length}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text flex-none text-sm"
          >
            ✕
          </button>
        </div>

        <ul className="flex-1 overflow-auto">
          {rows.length === 0 ? (
            <li className="text-text-subtle px-5 py-6 text-sm">Операций за этот день не было.</li>
          ) : (
            rows.map((row) =>
              row.kind === "sale" ? (
                <li
                  key={`sale-${row.sale.id}`}
                  className="border-border-soft bg-accent-tint/40 flex items-baseline gap-3 border-b px-5 py-2.5 last:border-0"
                >
                  <span className="num text-text-subtle w-11 flex-none text-xs">
                    {String(Math.floor(row.at / 60)).padStart(2, "0")}:
                    {String(row.at % 60).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {row.sale.serviceTitle}
                      {/* Число сеансов известно не всегда: курс собирается,
                          когда пациент начал ходить. «0 сеансов» — не данные. */}
                      {row.sale.sessionsTotal > 0 ? ` — курс ${row.sale.sessionsTotal} сеансов` : ""}
                    </span>
                    <span className="text-accent-text text-2xs font-medium">
                      покупка курса
                      {row.sale.patientName ? ` · ${row.sale.patientName}` : ""}
                    </span>
                  </span>
                  <span className="num text-accent-text flex-none text-xs font-medium">
                    {formatMoney(row.sale.amount)}
                  </span>
                </li>
              ) : (
                <li
                  key={row.appt.id}
                  className="border-border-soft flex items-baseline gap-3 border-b px-5 py-2.5 last:border-0"
                >
                  <span className="num text-text-subtle w-11 flex-none text-xs">
                    {String(Math.floor(row.at / 60)).padStart(2, "0")}:
                    {String(row.at % 60).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {row.appt.service || "услуга не указана"}
                    </span>
                    <span className="text-text-subtle text-2xs">
                      {row.appt.doctor}
                      {row.appt.patientName ? ` · ${row.appt.patientName}` : ""}
                    </span>
                  </span>
                  {(row.appt.price ?? 0) > 0 ? (
                    /*
                      Курсовая услуга с суммой — не ошибка, но и не молчаливая
                      строка: «БОС-терапия 2 800 ₽» рядом с «курс 3/10» читается
                      как сбой привязки. Сумма в записи YCLIENTS означает, что
                      этот приём оплатили отдельно — сеанс сверх курса или
                      разовый визит. Так и подписываем.
                    */
                    <span className="flex flex-none items-baseline gap-1.5">
                      {row.appt.courseService && !row.appt.courseSession ? (
                        <span
                          className="text-text-subtle text-2xs"
                          title="Курсовая услуга, но за этот приём взяли деньги в самой записи YCLIENTS: с курса сеанс не списан. Обычно это сеанс сверх курса или разовый визит."
                        >
                          отдельно
                        </span>
                      ) : null}
                      <span className="num text-text-muted text-xs">
                        {formatMoney(row.appt.price ?? 0)}
                      </span>
                    </span>
                  ) : row.appt.courseSession ? (
                    <span
                      className="text-text-subtle flex-none text-2xs"
                      title="оплачен при продаже курса — деньги дал день покупки"
                    >
                      курс {row.appt.courseSession.index}/{row.appt.courseSession.total}
                    </span>
                  ) : row.appt.amountSource === "PREPAID" ? (
                    <span
                      className="text-text-subtle flex-none text-2xs"
                      title="оплачен при продаже курса — деньги дал день покупки"
                    >
                      по курсу
                    </span>
                  ) : (
                    <span
                      className="text-text-subtle flex-none text-2xs"
                      title="подарок по скидке или приём, за который клиника денег не брала"
                    >
                      бесплатно
                    </span>
                  )}
                </li>
              ),
            )
          )}
        </ul>

        <div className="border-border flex items-baseline justify-between gap-3 border-t px-5 py-3">
          <span className="text-text-muted text-xs">Итого за день</span>
          <span className="num text-text text-sm font-medium">{formatMoney(total)}</span>
        </div>
      </div>
    </div>
  );
}
