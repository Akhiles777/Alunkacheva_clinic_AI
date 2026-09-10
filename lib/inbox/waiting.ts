/**
 * Сколько пациент ждёт ответа — и в каком порядке показывать диалоги.
 *
 * Список сортировался по времени последнего сообщения, и это разные вещи.
 * Пациент, написавший сорок минут назад и оставшийся без ответа, уезжал вниз
 * под свежую переписку, которую администратор только что закрыл; кто ждёт
 * дольше всех, не был виден вовсе. В смену это и означает потерянное
 * обращение: не «никто не заметил», а «заметили не того».
 *
 * Все правила здесь чистые и проверены тестами: экран только рисует.
 */

export interface QueueMessage {
  direction: "IN" | "OUT";
  createdAt: Date;
}

/**
 * С какого момента пациент ждёт.
 *
 * Это начало ПОСЛЕДНЕЙ непрерывной череды его сообщений: человек пишет три
 * реплики подряд, и ждёт он с первой, а не с третьей. Ответили — ожидание
 * кончилось, даже если пациент промолчал в ответ.
 */
export function waitingSince(messages: QueueMessage[]): Date | null {
  const ordered = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  let since: Date | null = null;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].direction !== "IN") break;
    since = ordered[i].createdAt;
  }
  return since;
}

/**
 * Непрочитанные — как в мессенджере: сколько сообщений пациента сотрудник
 * ещё не видел.
 *
 * Отметка прочтения ставится при открытии переписки. Её нет вовсе (диалог не
 * открывали ни разу) — считаем от нашего последнего ответа: всё, что пришло
 * после него, человек не читал. Иначе у старой переписки, которую вёл только
 * бот, счётчик показывал бы всю её историю.
 */
export function unreadCount(messages: QueueMessage[], staffReadAt: Date | null): number {
  const ordered = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (staffReadAt) {
    return ordered.filter((m) => m.direction === "IN" && m.createdAt > staffReadAt).length;
  }
  let n = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].direction !== "IN") break;
    n += 1;
  }
  return n;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * «ждёт 12 мин» — так, как это произносят вслух.
 *
 * Меньше минуты не пишем: «ждёт 0 мин» выглядит поломкой. Дни — потому что
 * «ждёт 2 880 мин» не читается, а решение по такому диалогу другое.
 */
export function waitLabel(ms: number): string | null {
  if (ms < MINUTE) return null;
  if (ms < HOUR) return `ждёт ${Math.floor(ms / MINUTE)} мин`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    return `ждёт ${h} ${h === 1 ? "час" : h < 5 ? "часа" : "часов"}`;
  }
  const d = Math.floor(ms / DAY);
  return `ждёт ${d} ${d === 1 ? "день" : d < 5 ? "дня" : "дней"}`;
}

/** Сколько ждать, прежде чем ожидание становится заметным на экране. */
export const URGENT_WAIT_MS = 30 * MINUTE;

export interface QueueRow {
  /** Когда пациент написал и остался без ответа. Пусто — не ждёт. */
  waitingSince: string | null;
  /** Время последнего сообщения переписки — запасной порядок. */
  at: number;
  escalated: boolean;
}

/**
 * Порядок списка: сначала те, кто ждёт, и дольше ждущий выше.
 *
 * Эскалация поднимается над обычным ожиданием: там уже сказано, что нужен
 * человек. Не ждущие идут дальше по времени последнего сообщения — то есть
 * так же, как раньше.
 *
 * Порядок обязан быть устойчивым: список перерисовывается каждые шесть
 * секунд, и строки, прыгающие местами при равных значениях, невозможно
 * нажать.
 */
export function compareQueue(a: QueueRow, b: QueueRow): number {
  const aw = a.waitingSince ? Date.parse(a.waitingSince) : null;
  const bw = b.waitingSince ? Date.parse(b.waitingSince) : null;

  if (a.escalated !== b.escalated) return a.escalated ? -1 : 1;
  if ((aw === null) !== (bw === null)) return aw === null ? 1 : -1;
  if (aw !== null && bw !== null && aw !== bw) return aw - bw;
  return b.at - a.at;
}
