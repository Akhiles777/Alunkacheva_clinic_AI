/**
 * Когда отправить и что написать — по просьбе администратора.
 *
 * «Через пять часов напиши Патимат, что врач задерживается» — здесь две вещи,
 * которые нельзя угадывать: МОМЕНТ отправки и ТЕКСТ. Оба разбираются правилами
 * и оба показываются человеку до отправки: пациент получит ровно то, что
 * администратор увидел на экране, и ровно тогда, когда там написано.
 *
 * Текст составляется из заготовок клиники, а не сочиняется моделью. Причина
 * та же, по которой агент отвечает пациенту только справкой: сочинённая
 * формулировка уходит от имени клиники, и отвечать за неё будет она. В
 * заготовках нет ни одного нового факта — только то, что назвал администратор.
 */

import { CLINIC_NAME } from "@/lib/brand";

/** Готовая ситуация, о которой пишут пациенту. */
export type Situation = "delay" | "reschedule" | "sick" | "remind" | "closed" | "custom";

const SITUATIONS: [RegExp, Situation][] = [
  [/задержив|задержк|опазд|опозда/i, "delay"],
  [/заболел|заболела|на\s+больнич/i, "sick"],
  [/перенос|перенест|сдвиг|сдвин|отмен/i, "reschedule"],
  [/напомн|напоминан/i, "remind"],
  [/не\s+работает|закрыт|выходной/i, "closed"],
];

export function situationOf(text: string): Situation | null {
  return SITUATIONS.find(([re]) => re.test(text))?.[1] ?? null;
}

export interface ComposeParams {
  /** Имя врача — если администратор его назвал или оно известно из записи. */
  doctorName?: string | null;
  /** Время записи пациента: «14:30». */
  visitTime?: string | null;
  /** День записи словами: «сегодня», «19 сентября». */
  visitDay?: string | null;
  /** На сколько задерживается приём, если сказано: «на 30 минут». */
  delayText?: string | null;
  /** Название клиники — подписью, чтобы пациент понял, кто пишет. */
  clinic?: string;
}

/**
 * Собрать текст сообщения.
 *
 * Ничего не выдумываем: времени, которого администратор не называл, в тексте
 * нет. Поэтому «задерживается» без указания на сколько звучит как
 * «задерживается» — а не «на полчаса».
 */
export function composeMessage(situation: Situation, params: ComposeParams = {}): string {
  const when = [params.visitDay, params.visitTime].filter(Boolean).join(" в ");
  const visit = when ? ` на ${when}` : "";
  const doctor = params.doctorName ? ` ${params.doctorName}` : "";
  /**
   * Подписываемся настоящим названием: «это клиника» пациент читает как
   * неизвестно чей номер, а первое сообщение от клиники должно узнаваться.
   */
  const clinic = params.clinic ?? CLINIC_NAME;

  switch (situation) {
    case "delay":
      return (
        `Здравствуйте! Это ${clinic}.${doctor ? ` Врач${doctor}` : " Врач"} задерживается` +
        `${params.delayText ? ` ${params.delayText}` : ""}. ` +
        `Приём${visit} состоится, но начнётся позже — извините за ожидание. ` +
        "Если время вам не подходит, напишите здесь же, подберём другое."
      );
    case "sick":
      /**
       * Без глагола в роде: «заболел» у женщины-врача читается как ошибка
       * клиники, а склонять и согласовывать имена кодом мы не беремся — то же
       * решение, что у агента.
       */
      return (
        `Здравствуйте! Это ${clinic}. К сожалению, приём${visit}` +
        `${doctor ? ` (врач${doctor})` : ""} не состоится: врач на больничном. ` +
        "Напишите, пожалуйста, когда вам удобно прийти, — подберём другое время."
      );
    case "reschedule":
      return (
        `Здравствуйте! Это ${clinic}. Ваш приём${visit} нужно перенести. ` +
        "Напишите, пожалуйста, когда вам удобно, — подберём время и подтвердим."
      );
    case "remind":
      return (
        `Здравствуйте! Это ${clinic}. Напоминаем о записи${visit}${doctor ? `, врач${doctor}` : ""}. ` +
        "Если планы изменились — напишите здесь же, освободим время."
      );
    case "closed":
      return (
        `Здравствуйте! Это ${clinic}. Сегодня мы не работаем, приём не состоится. ` +
        "Напишите, пожалуйста, когда вам удобно прийти, — подберём время."
      );
    default:
      return "";
  }
}

/**
 * Когда отправить: «через 5 часов», «в 18:00», «завтра в 9», «через 30 минут».
 *
 * Возвращает момент времени или null, если отправлять надо сейчас. Прошедшее
 * время не возвращаем никогда: отправка «в прошлое» означала бы, что сообщение
 * уйдёт немедленно, а администратор рассчитывал на другое.
 */
export function sendAtFrom(text: string, now: Date = new Date()): Date | null {
  const q = text.toLowerCase().replace(/ё/g, "е");

  // Без `\b`: в JavaScript он опирается на латинский \w и рядом с кириллицей
  // не срабатывает вовсе — «через 5 часов» не совпадало (CLAUDE.md, §6).
  const inUnits = q.match(/через\s+(\d{1,3})\s*(минут\p{L}*|мин|часов|часа|час|ч)(?!\p{L})/u);
  if (inUnits) {
    const n = Number(inUnits[1]);
    const isHour = inUnits[2].startsWith("ч");
    const ms = n * (isHour ? 3600 : 60) * 1000;
    if (n > 0 && ms <= 14 * 24 * 3600 * 1000) return new Date(now.getTime() + ms);
  }

  /** «через час», «через полчаса» — без числа. */
  if (/через\s+час(?![а-я])/.test(q)) return new Date(now.getTime() + 3600 * 1000);
  if (/через\s+полчаса/.test(q)) return new Date(now.getTime() + 30 * 60 * 1000);

  /** «завтра в 9», «сегодня в 17:30», «в 18:00». */
  const at = q.match(/(?:(сегодня|завтра|послезавтра)\s+)?в\s+(\d{1,2})(?:[:.](\d{2}))?(?!\d)/);
  if (at) {
    const shift = at[1] === "завтра" ? 1 : at[1] === "послезавтра" ? 2 : 0;
    const hour = Number(at[2]);
    const minute = at[3] ? Number(at[3]) : 0;
    if (hour <= 23 && minute <= 59) {
      const target = new Date(now);
      target.setDate(target.getDate() + shift);
      target.setHours(hour, minute, 0, 0);
      /**
       * «В 9» без дня, когда девять уже прошло, — это завтра: администратор
       * говорит о ближайшем таком часе, а не о вчерашнем.
       */
      if (target.getTime() <= now.getTime() && !at[1]) target.setDate(target.getDate() + 1);
      if (target.getTime() > now.getTime()) return target;
    }
  }

  /** «завтра утром» — девять утра: час открытия клиники не угадываем точнее. */
  if (/завтра\s+утром/.test(q)) {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(9, 0, 0, 0);
    return target;
  }

  return null;
}

/** «на 30 минут», «на час» — насколько задерживается приём. */
export function delayTextFrom(text: string): string | null {
  const m = text.toLowerCase().match(/на\s+(\d{1,3})\s*(минут\p{L}*|мин|час\p{L}*|ч)(?!\p{L})/u);
  if (m) {
    const n = Number(m[1]);
    const isHour = m[2].startsWith("ч");
    if (n > 0) return `примерно на ${n} ${isHour ? hourWord(n) : "минут"}`;
  }
  if (/на\s+полчаса/i.test(text)) return "примерно на полчаса";
  if (/на\s+час(?!\p{L})/iu.test(text)) return "примерно на час";
  return null;
}

function hourWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "час";
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return "часа";
  return "часов";
}
