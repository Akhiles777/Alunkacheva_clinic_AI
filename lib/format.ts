const integer = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const moneyPrecise = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatNumber(value: number): string {
  return integer.format(value);
}

/** Крупные суммы без копеек: на дашборде копейки — шум. */
export function formatMoney(value: number): string {
  return `${money.format(Math.round(value))} ₽`;
}

/** Средний чек — с копейками: там разница в рублях осмысленна. */
export function formatMoneyPrecise(value: number): string {
  return `${moneyPrecise.format(value)} ₽`;
}

/** 0.6041 → «60%». */
export function formatPercent(share: number, fractionDigits = 0): string {
  return `${(share * 100).toFixed(fractionDigits).replace(".", ",")}%`;
}

/** 150 → «2 ч 30 мин». */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} мин`;
  if (rest === 0) return `${hours} ч`;
  return `${hours} ч ${rest} мин`;
}

const dayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long" });

export function formatDateRange(fromIso: string, toIso: string): string {
  const from = new Date(fromIso);
  // Верхняя граница исключительная — показываем последний день периода.
  const to = new Date(new Date(toIso).getTime() - 24 * 60 * 60 * 1000);
  return `${dayMonth.format(from)} — ${dayMonth.format(to)}`;
}

export function formatDayLabel(iso: string): string {
  const date = new Date(iso);
  return `${weekday.format(date)}, ${dayMonth.format(date)}`;
}
