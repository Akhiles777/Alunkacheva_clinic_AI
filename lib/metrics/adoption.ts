/**
 * Перешёл ли администратор в систему.
 *
 * Весь цикл был про одно: убрать причины возвращаться к телефону и дать
 * причины остаться. Проверяется это одним числом — какая доля ответов
 * пациентам уходит ИЗ ПЛАТФОРМЫ, а не из WhatsApp на аппарате клиники.
 * Сообщения, отправленные с телефона, приходят к нам вебхуком, поэтому обе
 * половины видны и сравнимы.
 *
 * Число это не про сотрудника, а про инструмент: если доля не растёт, значит
 * в платформе чего-то не хватает — и разбираться надо с ней, а не с человеком.
 */

export interface OutgoingMessage {
  at: Date;
  /** Ушло из платформы: ставится в момент отправки. */
  viaPlatform: boolean;
  /** Автор-сотрудник. У сообщений с телефона его нет. */
  authorId: string | null;
  /** Ответ агента: он не про переход администратора и в счёт не идёт. */
  fromBot: boolean;
}

export interface Share {
  ours: number;
  phone: number;
  /** Доля наших от всех ручных ответов. Ответов не было — null, а не ноль. */
  share: number | null;
}

/**
 * Наше или с телефона.
 *
 * У сообщений, отправленных до появления явной отметки, её нет — там решает
 * автор: платформа его знает, вебхук с телефона нет. Признак косвенный,
 * поэтому применяется только к истории.
 */
export function fromPlatform(m: OutgoingMessage): boolean {
  return m.viaPlatform || m.authorId !== null;
}

export function platformShare(messages: OutgoingMessage[]): Share {
  const manual = messages.filter((m) => !m.fromBot);
  const ours = manual.filter(fromPlatform).length;
  const phone = manual.length - ours;
  return { ours, phone, share: manual.length === 0 ? null : ours / manual.length };
}

export interface ReplyEvent {
  at: Date;
  direction: "IN" | "OUT";
  /** Ответ человека. Ответ агента временем администратора не считается. */
  byStaff: boolean;
}

/**
 * Сколько пациент ждал первого ЧЕЛОВЕЧЕСКОГО ответа.
 *
 * Считаем от первого сообщения непрерывной череды пациента до ближайшего
 * ответа сотрудника — так же, как считается ожидание в списке. Ответ агента
 * ожидание не закрывает: администратор от этого быстрее не стал.
 *
 * Медиана, а не среднее: одно ночное сообщение с ответом через двенадцать
 * часов сдвигает среднее так, что типичный случай исчезает (§8).
 */
export function firstReplyMinutes(events: ReplyEvent[]): number[] {
  const ordered = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const waits: number[] = [];
  let waitingSince: Date | null = null;
  for (const e of ordered) {
    if (e.direction === "IN") {
      if (!waitingSince) waitingSince = e.at;
      continue;
    }
    if (!e.byStaff) continue;
    if (waitingSince) {
      waits.push((e.at.getTime() - waitingSince.getTime()) / 60_000);
      waitingSince = null;
    }
  }
  return waits;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Приёмы работы, за которыми следим.
 *
 * Список закрытый и короткий: считаем то, о чём можем что-то сделать. Ноль у
 * строки означает «не пользуются» — и это повод посмотреть, видно ли её
 * вообще, а не повод убрать возможность.
 */
export const FEATURES: { key: string; label: string }[] = [
  { key: "template", label: "шаблоны" },
  { key: "hotkey", label: "горячие клавиши" },
  { key: "attachment", label: "файлы" },
  { key: "voice", label: "голосовые" },
  { key: "note", label: "заметки по диалогу" },
  { key: "handoff", label: "передача коллеге" },
  { key: "later", label: "отложенная отправка" },
  { key: "bulk", label: "массовые действия" },
  { key: "dialog-open", label: "открытых переписок" },
];

export function isFeature(key: string): boolean {
  return FEATURES.some((f) => f.key === key);
}
