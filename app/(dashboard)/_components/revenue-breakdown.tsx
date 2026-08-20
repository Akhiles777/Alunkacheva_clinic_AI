"use client";

import { useEffect } from "react";
import { formatMoney } from "@/lib/format";
import type { Appt } from "@/app/_data/store";

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
  dateLabel,
  onClose,
}: {
  appts: Appt[];
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

  const rows = [...appts]
    .filter((a) => a.status === "arrived")
    .sort((a, b) => a.startMinute - b.startMinute);
  const total = rows.reduce((sum, a) => sum + (a.price ?? 0), 0);
  const byCourse = rows.filter((a) => (a.price ?? 0) === 0 && a.amountSource === "PREPAID").length;
  const free = rows.filter((a) => (a.price ?? 0) === 0 && a.amountSource !== "PREPAID").length;
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
              состоявшихся приёмов {rows.length}
              {notes.length > 0 ? `, из них ${notes.join(", ")}` : ""}
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
            <li className="text-text-subtle px-5 py-6 text-sm">Состоявшихся приёмов не было.</li>
          ) : (
            rows.map((a) => (
              <li
                key={a.id}
                className="border-border-soft flex items-baseline gap-3 border-b px-5 py-2.5 last:border-0"
              >
                <span className="num text-text-subtle w-11 flex-none text-xs">
                  {String(Math.floor(a.startMinute / 60)).padStart(2, "0")}:
                  {String(a.startMinute % 60).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{a.service || "услуга не указана"}</span>
                  <span className="text-text-subtle text-2xs">
                    {a.doctor}
                    {a.patientName ? ` · ${a.patientName}` : ""}
                  </span>
                </span>
                {(a.price ?? 0) > 0 ? (
                  <span className="num text-text-muted flex-none text-xs">
                    {formatMoney(a.price ?? 0)}
                  </span>
                ) : a.courseSession ? (
                  <span
                    className="text-text-subtle flex-none text-2xs"
                    title="оплачен при продаже курса — деньги дал день покупки"
                  >
                    курс {a.courseSession.index}/{a.courseSession.total}
                  </span>
                ) : a.amountSource === "PREPAID" ? (
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
            ))
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
