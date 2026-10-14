/**
 * Фильтры списка «Диалогов» — одним щелчком.
 *
 * Список по умолчанию идёт как в мессенджере: сверху последнее сообщение
 * (решение заказчика — без перестановок, которые надо держать в голове).
 * Фильтр «Ждут ответа» отвечает на другой вопрос — «кому писать первым», —
 * поэтому там дольше всех ждущий стоит наверху. Остальные фильтры — срочное:
 * нужен человек, новые обращения, отмены и переносы.
 */
export type InboxView = "all" | "waiting" | "human" | "new" | "schedule";

export interface ViewRow {
  id: string;
  /** С какого момента пациент пишет без ответа (ISO) — для порядка. */
  waitingSince?: string | null;
  /**
   * Ждёт ответа: новое от пациента, которого сотрудник ещё не видел, — то же
   * правило, что у клавиши «u» и числа непрочитанных. Одно «Спасибо!» в
   * конце прочитанной переписки ожиданием не считается.
   */
  unread?: boolean;
  escalated: boolean;
  firstTime?: boolean;
  scheduleChange?: "cancel" | "move" | null;
}

export const VIEWS: { key: InboxView; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "waiting", label: "Ждут ответа" },
  { key: "human", label: "Нужен человек" },
  { key: "new", label: "Новые" },
  { key: "schedule", label: "Отмены и переносы" },
];

export function inView(row: ViewRow, view: InboxView): boolean {
  switch (view) {
    case "all":
      return true;
    case "waiting":
      return Boolean(row.unread);
    case "human":
      return row.escalated;
    case "new":
      return Boolean(row.firstTime && row.unread);
    case "schedule":
      return Boolean(row.scheduleChange);
  }
}

/** Строки фильтра в его порядке: «Ждут ответа» — дольше ждущий выше, остальные как пришли. */
export function applyView<T extends ViewRow>(rows: T[], view: InboxView): T[] {
  const picked = rows.filter((r) => inView(r, view));
  if (view !== "waiting") return picked;
  return [...picked].sort(
    (a, b) => Date.parse(a.waitingSince ?? "") - Date.parse(b.waitingSince ?? "") || a.id.localeCompare(b.id),
  );
}

/** Сколько строк в каждом фильтре — число рядом с названием. */
export function viewCounts(rows: ViewRow[]): Record<InboxView, number> {
  const out = { all: 0, waiting: 0, human: 0, new: 0, schedule: 0 } as Record<InboxView, number>;
  for (const r of rows) for (const v of VIEWS) if (inView(r, v.key)) out[v.key] += 1;
  return out;
}
