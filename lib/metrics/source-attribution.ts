/**
 * Откуда пришёл пациент — выводим из переписки.
 *
 * Источник в YCLIENTS не заполняет никто: на боевых данных он не проставлен
 * ни у одного визита из 768, и вся воронка мертва. Администраторы это поле не
 * заполняют и не начнут — просить их об этом мы уже пробовали.
 *
 * Но у нас есть то, чего нет у YCLIENTS: переписка. Пациент, написавший в
 * WhatsApp и записанный после этого разговора, пришёл из WhatsApp. Это факт,
 * а не догадка, и на нём воронку можно построить честно.
 *
 * Чего мы НЕ делаем: не подставляем «звонок» или «офлайн», когда диалога
 * рядом нет. Отсутствие переписки не доказывает звонок — пациент мог прийти по
 * рекомендации, с улицы, из старой записи. Такой визит остаётся с источником
 * «неизвестен», и администратор может проставить его руками.
 */

export type SourceConfidence = "MANUAL" | "DERIVED" | "UNKNOWN";

/** Сколько дней до создания записи ищем разговор. */
export const LOOKBACK_DAYS = 14;
/** И сколько после: запись заводят прямо во время переписки. */
export const LOOKAHEAD_MS = 60 * 60 * 1000;

export interface DialogTouch {
  conversationId: string;
  /** Источник канала: whatsapp, instagram, telegram. */
  sourceId: string;
  /** Когда пациент писал в этом диалоге — ближайшее к записи сообщение. */
  messageAt: Date;
}

export interface AttributionInput {
  /** Когда запись создана в YCLIENTS. Именно создана, а не когда состоится. */
  createdAt: Date;
  /** Как сейчас проставлен источник у визита. */
  current: { sourceId: string | null; confidence: SourceConfidence };
  /** Сообщения пациента во всех его диалогах. */
  touches: DialogTouch[];
  /**
   * Запись создана ИЗ диалога: её завёл агент прямо в переписке.
   *
   * Это не догадка по времени, а прямая связь — сильнее любого окна. Такой
   * источник пересчёт не трогает: иначе запись, сделанная агентом в WhatsApp,
   * теряла бы источник только потому, что последнее сообщение пациента
   * оказалось на час раньше границы окна.
   */
  fromConversation?: boolean;
}

export interface AttributionResult {
  sourceId: string | null;
  confidence: SourceConfidence;
  /** Менять ли строку в базе. Ложь означает «оставить как есть». */
  changed: boolean;
  conversationId: string | null;
}

/**
 * Окно поиска разговора вокруг создания записи.
 *
 * Две недели назад — потому что между «написал» и «записался» проходит время:
 * человек спрашивает цену, думает, возвращается. Час вперёд — потому что
 * администратор нередко заводит запись прямо во время переписки, и по часам
 * она оказывается на минуту позже последнего сообщения.
 */
export function inWindow(createdAt: Date, messageAt: Date): boolean {
  const from = createdAt.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const to = createdAt.getTime() + LOOKAHEAD_MS;
  const at = messageAt.getTime();
  return at >= from && at <= to;
}

/**
 * Какой источник поставить визиту.
 *
 * MANUAL выигрывает всегда и безусловно. Администратор, проставивший источник
 * руками, знает больше нас: он говорил с человеком. Пересчёт, переписывающий
 * такую отметку, обесценивает саму возможность её поставить — второй раз её
 * никто вводить не станет.
 */
export function attributeSource(input: AttributionInput): AttributionResult {
  const keep = (): AttributionResult => ({
    sourceId: input.current.sourceId,
    confidence: input.current.confidence,
    changed: false,
    conversationId: null,
  });

  if (input.current.confidence === "MANUAL") return keep();
  // Запись заведена из переписки — источник известен точно, гадать не о чем.
  if (input.fromConversation && input.current.sourceId) return keep();

  const near = input.touches.filter((t) => inWindow(input.createdAt, t.messageAt));
  if (near.length === 0) {
    // Диалога рядом нет. Это не «звонок» — это «мы не знаем».
    const already = input.current.confidence === "UNKNOWN" && input.current.sourceId === null;
    return already
      ? keep()
      : { sourceId: null, confidence: "UNKNOWN", changed: true, conversationId: null };
  }

  /**
   * Диалогов несколько — берём тот, чьё сообщение ближе к моменту создания
   * записи. Человек мог писать и в WhatsApp, и в Telegram; записался он после
   * того разговора, который вёл в этот момент.
   *
   * При равном расстоянии берём меньший идентификатор диалога: результат
   * должен быть один и тот же при каждом пересчёте, а не зависеть от порядка
   * строк, который база не обещает.
   */
  const best = [...near].sort((a, b) => {
    const da = Math.abs(a.messageAt.getTime() - input.createdAt.getTime());
    const db = Math.abs(b.messageAt.getTime() - input.createdAt.getTime());
    return da - db || a.conversationId.localeCompare(b.conversationId);
  })[0];

  const same = input.current.sourceId === best.sourceId && input.current.confidence === "DERIVED";
  return {
    sourceId: best.sourceId,
    confidence: "DERIVED",
    changed: !same,
    conversationId: best.conversationId,
  };
}
