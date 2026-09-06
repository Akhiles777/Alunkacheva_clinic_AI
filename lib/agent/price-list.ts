/**
 * Прайс-лист для пациента.
 *
 * На «Цены» агент вываливал весь справочник целиком — сорок восемь строк, и
 * половина из них пациенту не предназначена: «Название — 0 ₽»,
 * «IV-ТЕРАПИЯ — 1 ₽», «БОС/персонал — 0 ₽», «Повторный прием невролога — 0 ₽».
 * Это заготовки и служебные позиции клиники. Человек, спросивший цену, получал
 * стену текста, в которой его услуги нужно ещё найти.
 *
 * Справочник при этом не трогаем: он приезжает из YCLIENTS и нужен клинике
 * целиком. Фильтруем только то, что показываем пациенту.
 */

export interface PriceListItem {
  title: string;
  price: number;
  durationMin: number;
}

/**
 * Сколько строк ещё читается как список, а не как стена.
 *
 * В мессенджере длинное сообщение сворачивается, и до конца его никто не
 * листает. Остальное называем числом и предлагаем спросить конкретную услугу —
 * на такой вопрос агент отвечает точно.
 */
export const PRICE_LIST_LIMIT = 25;

/**
 * Цена, которой пациент не платит.
 *
 * Ноль — заготовка или служебная позиция. Рубль — тоже заготовка: так в
 * YCLIENTS помечают услугу, цену которой ещё не завели («Сдача анализов — 1 ₽»
 * при настоящем чеке в несколько тысяч). Настоящих услуг за рубль у клиники
 * нет, и назвать такую цену пациенту — обмануть его.
 */
function isRealPrice(price: number): boolean {
  return price > 1;
}

/** Служебная позиция: приём сотруднику, а не пациенту. */
function isStaffOnly(title: string): boolean {
  return /персонал/i.test(title);
}

/** Услуги, которые уместно назвать пациенту. */
export function patientServices<T extends PriceListItem>(services: T[]): T[] {
  return services.filter((s) => isRealPrice(s.price) && !isStaffOnly(s.title));
}

/**
 * Одна и та же услуга дважды — не ответ, а вид поломки.
 *
 * В справочнике клиники есть настоящие дубли: «Внутривенное капельное введение
 * растворов» и «Внутривенное капельное введение растворов (IV-терапия)», обе
 * по 500 ₽. Пациент видит две одинаковые строки подряд и решает, что платформа
 * сломалась. Сливать дубли в справочнике — работа клиники (§8), но показывать
 * их человеку незачем.
 *
 * Признак дубля жёсткий: та же цена И одно название — начало другого. Так
 * «БОС-терапия» за 2800 и «БОС-терапия, курс» за 28000 остаются разными, а
 * они и есть разные.
 */
const bare = (t: string) =>
  t.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function dedupeServices<T extends PriceListItem>(list: T[]): T[] {
  const out: T[] = [];
  for (const s of list) {
    const key = bare(s.title);
    const twin = out.find((x) => {
      if (Number(x.price) !== Number(s.price)) return false;
      const other = bare(x.title);
      /**
       * Совпадать должно ЦЕЛОЕ слово, а не начало строки: «Услуга 1» и
       * «Услуга 10» — разные услуги, хоть одна и начинается с другой.
       */
      return other === key || other.startsWith(`${key} `) || key.startsWith(`${other} `);
    });
    if (!twin) out.push(s);
  }
  return out;
}

/** Строка прайса: «Остеопатия, приём Ирины — 8 000 ₽, 45 мин». */
export function priceLine(s: PriceListItem): string {
  // Длительность печатаем, только если она заведена: «0 мин» — это не факт
  // о приёме, а незаполненное поле.
  const duration = s.durationMin > 0 ? `, ${s.durationMin} мин` : "";
  return `• ${s.title} — ${s.price} ₽${duration}`;
}

/**
 * Ответ на «услуги и цены».
 *
 * Пустой список означает, что цен в справочнике нет вовсе — тогда честно
 * говорим об этом, а не отправляем пациенту пустое сообщение.
 */
export function priceListText(services: PriceListItem[], limit = PRICE_LIST_LIMIT): string | null {
  const shown = dedupeServices(patientServices(services));
  if (shown.length === 0) return null;

  const head = shown.slice(0, limit).map(priceLine);
  const rest = shown.length - head.length;
  const tail =
    rest > 0
      ? `\n\nЕсть ещё ${rest} услуг. Напишите название — назову цену и длительность.`
      : "\n\nНапишите название услуги — расскажу подробнее.";
  return `Услуги и цены:\n${head.join("\n")}${tail}`;
}
