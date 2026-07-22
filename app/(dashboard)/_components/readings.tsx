import { formatMoney, formatMoneyPrecise, formatNumber } from "@/lib/format";
import type { MoneySummary, PeriodInfo } from "@/lib/metrics/types";

/**
 * Показания прибора: выручка, средний чек, новые пациенты.
 * Не карточки — вставки в общем пазу, разделённые волосяной линией.
 */
function Reading({
  label,
  value,
  hint,
  lead = false,
}: {
  label: string;
  value: string;
  hint?: string;
  lead?: boolean;
}) {
  return (
    <div className="bg-inset px-3 py-2.5">
      <p className="legend">{label}</p>
      <p
        className={`num mt-1.5 leading-none whitespace-nowrap ${lead ? "text-[22px] md:text-[28px]" : "text-[18px] md:text-[20px]"}`}
      >
        {value}
      </p>
      {hint ? <p className="text-label mt-1.5 text-[11px] leading-tight">{hint}</p> : null}
    </div>
  );
}

export function Readings({
  money,
  period,
}: {
  money: MoneySummary;
  period: PeriodInfo;
}) {
  const perDay = period.workingDays > 0 ? money.revenue / period.workingDays : 0;
  const hasData = money.revenue > 0 || money.newPatients > 0;

  return (
    <div className="border-groove bg-groove grid grid-cols-1 gap-px border sm:grid-cols-3">
      <Reading
        label="Выручка"
        value={hasData ? formatMoney(money.revenue) : "—"}
        hint={
          hasData
            ? `${formatMoney(perDay)} в рабочий день · курсами ${formatMoney(money.courseRevenue)}`
            : "за период записей нет"
        }
        lead
      />
      <Reading
        label="Средний чек"
        value={money.avgCheck > 0 ? formatMoneyPrecise(money.avgCheck) : "—"}
        hint="выручка / пришедшие"
      />
      <Reading
        label="Новые пациенты"
        value={hasData ? formatNumber(money.newPatients) : "—"}
        hint={
          hasData
            ? `курсов ${formatNumber(money.coursesSold)} на ${formatMoney(money.coursesAmount)}`
            : undefined
        }
      />
    </div>
  );
}
