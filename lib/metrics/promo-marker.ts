/**
 * Метка школы в сообщении пациента.
 *
 * Школа у акции одна, и метка — сами слова «школьный ресурс» (решение
 * заказчика, 20 октября: «зачем [ШК], просто пускай будет школьный ресурс»).
 * Ссылка со школьного материала (`/children` → wa.me) подставляет готовый
 * текст «Здравствуйте! Хочу записать ребёнка на школьный ресурс»; человек может
 * его поправить, поэтому фраза узнаётся по началу слов — в любом падеже, без
 * регистра, «ё» и знаков: «школьного ресурса», «Школьный ресурс 6+». Метка из
 * значков («[ШК]», прежняя) сверяется буква в букву без пробелов. Сообщения
 * клиники не в счёт — это проверяется по направлению, а не здесь.
 *
 * Цена такой метки названа заказчику: слова «школьный ресурс» напишет и тот,
 * кто узнал об акции не от школы. Поэтому ночной разбор переписки ищет у
 * привязанных по метке упоминание ДРУГОЙ школы и отдаёт такие привязки на
 * проверку человеку (lib/server/promo-ai.ts).
 *
 * Засчитывается метка в первые сутки ОБРАЩЕНИЯ, а не чата. Чат с постоянной
 * пациенткой может тянуться год; «первые 24 часа диалога» для неё — это сутки
 * с того сообщения, которым она начала нынешний разговор после паузы. Пауза —
 * те же 24 часа, что у метрики «обращения» (§8).
 */

const DAY = 24 * 3600_000;

/** Метка по умолчанию и текст ссылки. Метка — часть текста, отдельно не дописывается. */
export const DEFAULT_MARKER = "школьный ресурс";
export const LINK_TEXT = "Здравствуйте! Хочу записать ребёнка на школьный ресурс";
/** Прежняя метка — её заменяем на новую, если её никто не менял руками. */
export const LEGACY_MARKER = "[ШК]";

/** Метка, которой пользуемся: прежнее значение по умолчанию «[ШК]» читается как новая фраза. */
export function effectiveMarker(marker: string | null | undefined): string {
  const m = (marker ?? "").trim();
  return !m || m === LEGACY_MARKER ? DEFAULT_MARKER : m;
}

const squash = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, "");
const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
/** Основа слова: окончание падежа срезается, короткие слова — целиком. */
const stemOf = (w: string) => (w.length > 4 ? w.slice(0, Math.max(4, w.length - 2)) : w);

/** Метка-фраза — два и больше слов из букв; иначе метка-значок. */
function phraseStems(marker: string): string[] | null {
  const words = wordsOf(marker);
  if (words.length < 2 || !words.every((w) => /^\p{L}+$/u.test(w))) return null;
  if (/[^\p{L}\s]/u.test(marker.trim())) return null;
  return words.map(stemOf);
}

/** Есть ли метка в тексте. Пустая метка не находится нигде. */
export function hasMarker(text: string, marker: string): boolean {
  const stems = phraseStems(marker);
  if (stems) {
    const words = wordsOf(text);
    for (let i = 0; i + stems.length <= words.length; i += 1) {
      if (stems.every((st, j) => words[i + j].startsWith(st))) return true;
    }
    return false;
  }
  const m = squash(marker);
  if (m.length < 2) return false;
  return squash(text).includes(m);
}

/** Грубый отбор в базе (`contains`, без регистра): то, без чего метки в тексте точно нет. */
export function markerProbe(marker: string): string {
  const stems = phraseStems(marker);
  if (stems) return stems.reduce((a, b) => (b.length > a.length ? b : a));
  return marker.replace(/[[\]\s]/g, "").slice(0, 8);
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

/**
 * Ссылка на WhatsApp клиники с готовым текстом. Метка дописывается, только если
 * её нет в самом тексте (фраза «школьный ресурс» в нём уже есть). Нет номера —
 * ссылки нет.
 */
export function waLink(phone: string | null | undefined, marker: string, text = LINK_TEXT): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  const full = hasMarker(text, marker) || !marker.trim() ? text : `${text} ${marker}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(full.trim())}`;
}

/**
 * Запрос за превью ссылки, а не человек: мессенджеры и соцсети открывают
 * ссылку сами, чтобы показать карточку, — такие переходы не считаем.
 */
export function isPreviewBot(userAgent: string | null | undefined): boolean {
  const ua = userAgent ?? "";
  if (!ua.trim()) return true;
  return /bot\b|bot\/|crawler|spider|preview|facebookexternalhit|whatsapp\/|telegrambot|vkshare|skypeuripreview|slackbot|discordbot|yandex(?:bot|images)|googlebot|bingbot|curl\/|wget\/|python-requests|headless/i.test(ua);
}
