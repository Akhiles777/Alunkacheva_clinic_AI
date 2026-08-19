/**
 * Продажа курса в кассе YCLIENTS.
 *
 * Курс не продаётся записью приёма. Разведка показала, где он лежит: две
 * кассовые операции 17 августа с одним `sold_item_id` на 13 000 и 15 000 ₽ —
 * это одна продажа на 28 000 ₽, та самая «БОС-терапия, 10 сеансов». Сеансы
 * этой пациентки начинаются на следующий день.
 *
 * Поэтому продажу собираем из операций, а не гадаем по оплатам в записях.
 * Абонементов API не отдаёт вовсе (пять адресов, все 404), кассовые операции —
 * единственный источник, который у нас есть.
 */

export interface RawTransaction {
  id?: number;
  date?: string;
  amount?: number;
  /** Пусто приходит массивом, а не null: у операции без клиента `client: []`. */
  client?: { id?: number } | unknown[] | null;
  sold_item_id?: number;
  sold_item_type?: string | null;
  record_id?: number;
  visit_id?: number;
}

export interface Purchase {
  /** Клиент YCLIENTS — по нему находим пациента. */
  clientId: number;
  /** День, когда приняли деньги. Он же день продажи курса. */
  at: Date;
  amount: number;
  /** Номер продажи в YCLIENTS; по нему склеиваются строки одной покупки. */
  saleId: number | null;
}

function clientIdOf(t: RawTransaction): number | null {
  const c = t.client;
  if (!c || Array.isArray(c)) return null;
  const id = (c as { id?: number }).id;
  return typeof id === "number" && id > 0 ? id : null;
}

/**
 * Отобрать продажи и склеить строки одной покупки.
 *
 * Что отбрасываем и почему:
 *
 *   - Отрицательные суммы — это расходы: зарплата, закупка. В кассе они лежат
 *     вперемешку с выручкой, и складывать их с продажами нельзя.
 *   - Операции без клиента — общая касса клиники, к курсу отношения не имеют.
 *   - Операции, привязанные к записи или визиту, — оплата конкретного приёма.
 *     Её стоимость уже стоит в самой записи, и считать её продажей курса
 *     значило бы удвоить деньги.
 *   - Операции без вида проданного (`sold_item_type`). У найденной продажи он
 *     `goods_transaction` — продан товар/пакет. Пустой вид означает движение
 *     денег, а не продажу: у расхода он null. Без этого условия наличная
 *     оплата обычного приёма, которой не проставили номер записи, открывала бы
 *     пациенту курс, которого он не покупал.
 *
 * Повторы отбрасываем по номеру операции. Страницы выгрузки могут прийти
 * внахлёст, а строки одной продажи складываются: два экземпляра одной и той же
 * операции превратили бы курс за 28 000 ₽ в курс за 56 000 ₽.
 *
 * Строки с одним `sold_item_id` — одна покупка, разбитая на части оплаты
 * (13 000 наличными и 15 000 картой). Складываем их: курс продан один.
 */
export function coursePurchases(rows: RawTransaction[]): Purchase[] {
  const byKey = new Map<string, Purchase>();
  const seen = new Set<number>();

  for (const t of rows) {
    if (typeof t.id === "number") {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
    }
    const amount = t.amount ?? 0;
    if (amount <= 0) continue;
    const clientId = clientIdOf(t);
    if (clientId === null) continue;
    if ((t.record_id ?? 0) > 0 || (t.visit_id ?? 0) > 0) continue;
    if (typeof t.sold_item_type !== "string" || t.sold_item_type.trim().length === 0) continue;
    const at = t.date ? new Date(t.date) : null;
    if (!at || Number.isNaN(at.getTime())) continue;

    const saleId = (t.sold_item_id ?? 0) > 0 ? (t.sold_item_id as number) : null;
    // Без номера продажи склеиваем по клиенту и минуте: одна покупка пробивается
    // одним движением, и разные покупки в одну минуту у одного человека — не тот
    // случай, ради которого стоит усложнять.
    const key = saleId !== null ? `s${saleId}` : `c${clientId}|${Math.floor(at.getTime() / 60_000)}`;

    const found = byKey.get(key);
    if (found) {
      found.amount += amount;
      // Днём продажи считаем самую раннюю строку покупки.
      if (at < found.at) found.at = at;
    } else {
      byKey.set(key, { clientId, at, amount, saleId });
    }
  }

  return [...byKey.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}
