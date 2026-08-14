/**
 * Постраничная выгрузка и окна по датам.
 *
 * Прежняя синхронизация забирала одну страницу и один диапазон по умолчанию:
 * у клиники с тысячей клиентов импортировалась первая сотня, а записи —
 * только за то окно, которое YCLIENTS отдаёт без параметров. Начальная
 * выгрузка обязана быть полной (§5), иначе «первичный/повторный» и «новые
 * пациенты» врут весь первый месяц.
 *
 * Здесь только чистая арифметика страниц и дат — сетевые детали в client.ts.
 */

/** Сколько записей просим за раз. Больше — риск таймаута на стороне YCLIENTS. */
export const PAGE_SIZE = 200;

/** Предохранитель от бесконечного цикла, если сервер всегда отдаёт полную страницу. */
export const MAX_PAGES = 500;

export interface Page {
  page: number;
  count: number;
}

/**
 * Нужна ли следующая страница.
 *
 * Полагаться на total_count нельзя: он есть не во всех ответах. Поэтому
 * основной признак — страница пришла полной. Если total_count известен, он
 * останавливает нас раньше.
 */
export function hasNextPage(input: {
  received: number;
  pageSize: number;
  fetchedSoFar: number;
  totalCount?: number | null;
  page: number;
}): boolean {
  if (input.page >= MAX_PAGES) return false;
  if (input.received === 0) return false;

  /**
   * Общее число важнее «короткой страницы».
   *
   * Раньше страница меньше запрошенной считалась последней. У YCLIENTS размер
   * страницы фиксированный: просишь 200 клиентов — приходит 25, и выгрузка
   * останавливалась после первой страницы. У клиники с 1816 карточками
   * импортировалось 25, а визиты потом не с кем было связать: без пациента
   * запись в проекцию не пишется, и из 3759 визитов доехал один.
   *
   * Поэтому сначала смотрим, сколько всего обещал сервер.
   */
  if (typeof input.totalCount === "number" && input.totalCount >= 0) {
    return input.fetchedSoFar < input.totalCount;
  }
  if (input.received < input.pageSize) return false;
  return true;
}

export interface DateWindow {
  from: Date;
  to: Date;
}

/**
 * Разбить период на календарные месяцы.
 *
 * Записи за два года одним запросом не забрать: YCLIENTS ограничивает выдачу,
 * а мы упрёмся в таймаут. Месяц — размер, при котором и объём умеренный, и
 * запросов не тысячи.
 *
 * Границы полуинтервальные: [from, to). Соседние окна не перекрываются, иначе
 * одни и те же записи прилетят дважды — при upsert это не создаст дублей, но
 * потратит лимит запросов.
 */
export function monthWindows(from: Date, to: Date): DateWindow[] {
  if (!(from < to)) return [];
  const windows: DateWindow[] = [];
  let cursor = startOfMonth(from);
  if (cursor < from) cursor = from;

  while (cursor < to) {
    const next = startOfMonth(addMonths(cursor, 1));
    const end = next < to ? next : to;
    windows.push({ from: new Date(cursor), to: new Date(end) });
    cursor = end;
  }
  return windows;
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/** Дата в формате YCLIENTS: YYYY-MM-DD. */
export function apiDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
