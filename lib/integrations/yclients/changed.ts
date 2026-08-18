import type { ExistingRecord } from "./lookups";

/**
 * Изменился ли визит на самом деле.
 *
 * Последний месяц перечитывается каждым кругом выгрузки — иначе отметка
 * «пришёл», поставленная задним числом, до нас не доедет (§8). Но перечитать
 * не значит переписать: до сих пор каждая выгрузка безусловно обновляла все
 * прочитанные строки, и в базе у сотен визитов вставало свежее время
 * изменения. Из-за этого на вопрос «а изменилось ли хоть что-то за полчаса»
 * ответить было нечем: изменилось всё и всегда.
 *
 * Сравниваем ровно те поля, которые пишет выгрузка. Заметку администратора,
 * привязку к диалогу и прочее своё она не трогает — их здесь и нет.
 */

/** Значение из базы к сравнимому виду: даты, Decimal и null пишутся по-разному. */
function plain(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return String(v.getTime());
  // Decimal у Prisma — объект; строковое представление у равных значений совпадает.
  return String(v);
}

export interface RecordChangeInput {
  /** Что записано у нас. */
  existing: ExistingRecord;
  /** Что приехало из YCLIENTS. */
  incoming: Record<string, unknown>;
  /** Прислал ли провайдер дату создания: иначе поле не трогаем вовсе. */
  createdAtKnown: boolean;
}

export function recordChanged({ existing, incoming, createdAtKnown }: RecordChangeInput): boolean {
  // Визит был помечен удалённым, а YCLIENTS его снова показывает — это изменение.
  if (existing.deletedAt !== null) return true;

  const fields = [
    "staffId",
    "patientId",
    "roomId",
    "primaryServiceId",
    "startAt",
    "endAt",
    "durationMin",
    "status",
    "attendanceRaw",
    "revenue",
    "revenueSource",
    "isPaid",
    "syncState",
  ] as const;

  for (const key of fields) {
    if (plain((existing as unknown as Record<string, unknown>)[key]) !== plain(incoming[key])) {
      return true;
    }
  }

  // Дату создания сверяем, только если провайдер её действительно прислал:
  // иначе там заглушка — дата визита, и сравнивать её не с чем.
  if (createdAtKnown && plain(existing.createdAtYclients) !== plain(incoming.createdAtYclients)) {
    return true;
  }

  return false;
}
