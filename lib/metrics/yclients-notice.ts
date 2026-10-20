/**
 * Уведомления YCLIENTS, ушедшие пациенту с номера клиники, — как КОНТРОЛЬНЫЙ
 * сигнал для акции, а не источник данных.
 *
 * «Вы записаны на услугу Школьный ресурс 6+ …», «Отменена запись. Услуга: …» —
 * YCLIENTS шлёт сам, и они лежат в переписке. Если уведомление о записи на
 * услугу акции есть, а записи в нашей проекции нет — это расхождение: выгрузка
 * что-то пропустила. Из текста уведомлений НИЧЕГО не создаётся и не меняется:
 * источник истины — API YCLIENTS (§2). Здесь только разбор текста.
 *
 * Шаблоны — живые, с боевого номера (диагностика 20 октября):
 *   «Вы записаны на услугу X к специалисту Y на 21 октября 2026 в 10:30. …»
 *   «Добрый день, Имя. ⏎ Вы записаны к специалисту Y на X 21 октября 2026 в 10:30.»
 *   «Ваша запись изменена. Вы записаны на X на 21 октября 2026 в 10:30. …»
 *   «Запись подтверждена. специалисту: Y, Услуга: X, Время: 21 октября 2026 в 10:30.»
 *   «Отменена запись. Услуга: X, специалисту: Y, Время: 21 октября 2026 в 10:30.»
 * Во всех дата с годом — так человек обычно не пишет.
 */

export type NoticeKind = "booked" | "changed" | "confirmed" | "cancelled" | "reminder";

export interface ParsedNotice {
  kind: NoticeKind;
  /** Текст до даты: в нём услуга и специалист. */
  head: string;
  /** Время приёма по часам клиники. */
  local: { year: number; month: number; day: number; hour: number; minute: number };
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

const KINDS: { kind: NoticeKind; re: RegExp }[] = [
  { kind: "cancelled", re: /^\s*отменена\s+запись/iu },
  { kind: "changed", re: /^\s*ваша\s+запись\s+изменена/iu },
  { kind: "confirmed", re: /^\s*запись\s+подтверждена/iu },
  { kind: "booked", re: /^\s*вы\s+записаны\s+на\s+услугу/iu },
  { kind: "reminder", re: /^\s*(?:добрый\s+(?:день|вечер)|доброе\s+утро|здравствуйте)[\s\S]{0,60}?вы\s+записаны\s+к\s+специалисту/iu },
];

const DATE = new RegExp(`(\\d{1,2})\\s+(${MONTHS.join("|")})\\s+(\\d{4})\\s+в\\s+(\\d{1,2}):(\\d{2})`, "iu");

export function parseNotice(text: string): ParsedNotice | null {
  const kind = KINDS.find((k) => k.re.test(text))?.kind;
  if (!kind) return null;
  const m = DATE.exec(text);
  if (!m) return null;
  return {
    kind,
    head: text.slice(0, m.index),
    local: {
      day: Number(m[1]),
      month: MONTHS.indexOf(m[2].toLowerCase()) + 1,
      year: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
    },
  };
}

/** Уведомление про услугу акции: в его «голове» есть ключевое слово («школьн»). */
export function noticeAboutPromo(notice: ParsedNotice, keywords: string[]): boolean {
  const head = notice.head.toLowerCase().replace(/ё/g, "е");
  return keywords.some((k) => k.trim().length >= 3 && head.includes(k.trim().toLowerCase().replace(/ё/g, "е")));
}

export type NoticeMismatch = "booked-missing" | "cancelled-alive";

/**
 * Расходится ли уведомление с проекцией. `records` — записи пациента с услугой
 * акции в пределах нескольких минут от времени уведомления.
 */
export function noticeMismatch(
  notice: ParsedNotice,
  records: { status: string; deleted: boolean }[],
): NoticeMismatch | null {
  const alive = records.filter((r) => !r.deleted && r.status !== "CANCELLED");
  if (notice.kind === "cancelled") return alive.length > 0 ? "cancelled-alive" : null;
  return alive.length === 0 ? "booked-missing" : null;
}
