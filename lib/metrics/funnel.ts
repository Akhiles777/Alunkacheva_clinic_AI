import type { FunnelCounts, FunnelStep } from "./types";

const STEP_LABELS: { key: keyof FunnelCounts; label: string }[] = [
  { key: "inquiries", label: "Обращения" },
  { key: "booked", label: "Записались" },
  { key: "arrived", label: "Пришли" },
];

/**
 * Разворачивает три числа воронки в шаги с конверсией и потерями.
 *
 * Воронка показывается связанным блоком, поэтому проценты считаются здесь,
 * а не в разметке: потеря между шагами — это то, ради чего экран открывают.
 */
export function buildFunnel(counts: FunnelCounts): FunnelStep[] {
  const top = counts[STEP_LABELS[0].key];

  return STEP_LABELS.map(({ key, label }, index) => {
    const value = counts[key];
    const prev = index === 0 ? null : counts[STEP_LABELS[index - 1].key];

    /**
     * Конверсия между шагами.
     *
     * Обращения и записи — разные множества: записаться можно по телефону и
     * прямо в YCLIENTS, не написав ни слова в переписке. На боевых данных это
     * дало «обратились 2, записались 51 — 2550%». Само число 51 верное, а
     * процент от чужого множества — нет, и показывать его нельзя: по нему
     * принимают решения. Поэтому на переходе «обращения → записались» доля
     * показывается, только если записей не больше, чем обращений.
     *
     * Дальше, на переходе «записались → пришли», превышение законно и
     * скрывать его не надо: запись могла быть создана в прошлом периоде, а
     * визит состояться в этом.
     */
    const raw = prev === null ? null : prev === 0 ? 0 : value / prev;
    const fromInquiries = index === 1;
    const show = raw !== null && (!fromInquiries || raw <= 1);

    const conversionFromPrev = show ? raw : null;
    const lostFromPrev = prev === null || !show ? null : Math.max(prev - value, 0);
    const lossRateFromPrev = conversionFromPrev === null ? null : Math.max(1 - conversionFromPrev, 0);

    return {
      key,
      label,
      value,
      shareOfTop: top === 0 ? 0 : value / top,
      conversionFromPrev,
      lostFromPrev,
      lossRateFromPrev,
    };
  });
}
