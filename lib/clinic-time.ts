/**
 * Время клиники.
 *
 * Всё, что показывается человеку и всё, что делит данные на «сегодня» и
 * «вчера», считается в часовом поясе клиники — не сервера. Разница не
 * теоретическая: сервер обычно живёт по UTC, и без явного пояса время
 * сообщения в инбоксе показывалось на три часа раньше настоящего, а «сегодня»
 * начиналось в три часа ночи. Ошибка тихая — числа выглядят правдоподобно.
 *
 * Пояс берём из настроек развёртывания (`CLINIC_TIMEZONE`), по умолчанию
 * московский: Махачкала живёт по нему же.
 */
export const CLINIC_TZ = process.env.CLINIC_TIMEZONE?.trim() || "Europe/Moscow";

/** Дата в поясе клиники как «ГГГГ-ММ-ДД». */
export function clinicDateKey(at: Date = new Date(), tz: string = CLINIC_TZ): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Смещение пояса клиники в минутах на указанный момент. */
function offsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(raw);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Начало сегодняшних суток клиники.
 *
 * Заменяет `new Date(); setHours(0,0,0,0)` — тот брал полночь по часам
 * сервера, и на UTC-хостинге «сегодня» начиналось в 03:00 по клинике: три часа
 * каждой ночи новые пациенты и обращения считались вчерашними.
 */
export function startOfClinicDay(at: Date = new Date(), tz: string = CLINIC_TZ): Date {
  const key = clinicDateKey(at, tz);
  const guess = new Date(`${key}T00:00:00Z`);
  const off = offsetMinutes(guess, tz);
  return new Date(guess.getTime() - off * 60_000);
}

/** Сутки клиники: [начало сегодня, начало завтра). */
export function clinicDayRange(at: Date = new Date(), tz: string = CLINIC_TZ) {
  const start = startOfClinicDay(at, tz);
  return { start, end: startOfClinicDay(new Date(start.getTime() + 36 * 3600_000), tz) };
}
