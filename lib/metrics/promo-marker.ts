/**
 * Метка школы в сообщении пациента: «…на школьный ресурс [ШК]».
 *
 * Ссылка wa.me со школьного материала подставляет в поле ввода готовый текст с
 * меткой. Человек может его поправить, поэтому метка узнаётся без регистра и
 * без пробелов внутри скобок: «[шк]», «[ ШК ]». Сообщения клиники не в счёт —
 * это проверяется по направлению, а не здесь.
 *
 * Засчитывается метка в первые сутки ОБРАЩЕНИЯ, а не чата. Чат с постоянной
 * пациенткой может тянуться год; «первые 24 часа диалога» для неё — это сутки
 * с того сообщения, которым она начала нынешний разговор после паузы. Пауза —
 * те же 24 часа, что у метрики «обращения» (§8).
 */

const DAY = 24 * 3600_000;

const squash = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, "");

/** Есть ли метка в тексте. Пустая метка не находится нигде. */
export function hasMarker(text: string, marker: string): boolean {
  const m = squash(marker);
  if (m.length < 2) return false;
  return squash(text).includes(m);
}

/**
 * Пришла ли метка в первые сутки обращения.
 *
 * `incomingBefore` — моменты входящих сообщений пациента в этой переписке ДО
 * сообщения с меткой (порядок любой). Начало обращения — самое раннее из
 * цепочки, где соседние сообщения ближе суток друг к другу.
 */
export function inFirstDay(markerAt: Date, incomingBefore: Date[]): boolean {
  const earlier = incomingBefore
    .map((d) => d.getTime())
    .filter((t) => t < markerAt.getTime())
    .sort((a, b) => b - a);
  let start = markerAt.getTime();
  for (const t of earlier) {
    if (start - t >= DAY) break;
    start = t;
  }
  return markerAt.getTime() - start < DAY;
}

/** Ссылка на WhatsApp клиники с готовым текстом и меткой. Нет номера — ссылки нет. */
export function waLink(phone: string | null | undefined, marker: string, text = "Здравствуйте! Хочу записать ребёнка на школьный ресурс"): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(`${text} ${marker}`.trim())}`;
}
