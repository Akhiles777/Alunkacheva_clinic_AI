import { startsWithGreeting } from "@/lib/agent/greeting";

/**
 * Личное дело пациента: что о человеке знает клиника.
 *
 * Считается ИЗ СВОИХ ДАННЫХ и ничего не отправляет наружу. Переписка с
 * клиникой — это врачебная тайна (ст. 13 323-ФЗ) и персональные данные (§7):
 * тексты сообщений не покидают периметр, и «разбор диалога» здесь означает
 * счёт по своим правилам, а не пересказ модели.
 *
 * Что можно узнать, не выходя за периметр, оказывается почти всем, что нужно
 * администратору перед разговором: какие услуги человек берёт, с какой
 * частотой ходит, в какое время пишет, как быстро отвечает, здоровается ли,
 * на «вы» или на «ты», просил ли человека вместо бота.
 *
 * ГЛАВНОЕ ПРАВИЛО: ни одна строка совета не появляется без основания. У
 * каждого вывода есть порог наблюдений; не набралось — вывода нет, а не
 * «среднее по больнице». Совет, придуманный по одному сообщению, хуже
 * отсутствия совета: администратор поверит ему в разговоре с живым человеком.
 */

/** Меньше этого числа сообщений — о манере общения судить не по чему. */
export const MIN_MESSAGES_FOR_STYLE = 5;
/** Меньше этого числа визитов — о ритме и предпочтениях судить не по чему. */
export const MIN_VISITS_FOR_RHYTHM = 3;

export type ProfileVisitStatus = "CREATED" | "CONFIRMED" | "ARRIVED" | "NO_SHOW" | "CANCELLED";

export interface ProfileVisit {
  at: Date;
  status: ProfileVisitStatus;
  staffName: string | null;
  /** Состав визита: у записи бывает несколько услуг (§8). */
  services: { title: string; amount: number }[];
  revenue: number;
}

export interface ProfileMessage {
  direction: "IN" | "OUT";
  authorType: "PATIENT" | "BOT" | "STAFF";
  body: string;
  at: Date;
  /** Голосовое, фото, документ — по ним видно, как человеку удобно. */
  hasAttachment: boolean;
  /** Час в зоне клиники: считать по UTC нельзя, сдвиг меняет вывод. */
  clinicHour: number;
}

export interface ServicePreference {
  title: string;
  count: number;
  revenue: number;
}

export interface CommunicationStyle {
  /** Сообщений пациента — знаменатель всех выводов ниже. */
  messages: number;
  /** Хватает ли наблюдений, чтобы вообще о чём-то говорить. */
  enough: boolean;
  /** Медиана длины сообщения в знаках. */
  medianLength: number | null;
  /** Медиана времени ответа пациента на наше сообщение, в минутах. */
  medianReplyMinutes: number | null;
  /** Типичный час, когда пишет (медиана). */
  typicalHour: number | null;
  /** Доля сообщений, начинающихся с приветствия. */
  greetsShare: number | null;
  /** «вы», «ты» или неизвестно — по обращению в тексте. */
  address: "formal" | "informal" | null;
  voiceOrPhotos: number;
  /** Сколько раз просил живого человека вместо бота. */
  askedForHuman: number;
}

export interface PatientProfile {
  visits: {
    total: number;
    arrived: number;
    noShow: number;
    cancelled: number;
    /** Прошедшие приёмы без отметки исхода — те же, что в §8. */
    unmarked: number;
    firstAt: Date | null;
    lastAt: Date | null;
  };
  services: ServicePreference[];
  staff: { name: string; count: number }[];
  /** Как часто ходит: медиана дней между состоявшимися визитами. */
  rhythm: { medianDays: number | null; meanDays: number | null; gaps: number };
  money: { total: number; paidVisits: number; avgCheck: number | null };
  style: CommunicationStyle;
  /** Что делать в разговоре — только выводы с основанием. */
  advice: { text: string; basis: string }[];
}

const DAY = 24 * 3600 * 1000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Пациент обращается на «вы» или на «ты».
 *
 * Считаем по отдельным словам, а не по вхождению подстроки: «вы» внутри
 * «выписка» и «ты» внутри «стыд» не значат ничего. Решает перевес: одно
 * случайное «ты» у вежливого человека вывод менять не должно.
 */
export function addressForm(texts: string[]): "formal" | "informal" | null {
  let formal = 0;
  let informal = 0;
  for (const t of texts) {
    const words = t.toLowerCase().replace(/ё/g, "е").split(/[^а-яa-z]+/);
    for (const w of words) {
      if (["вы", "вас", "вам", "вами", "ваш", "ваша", "ваши", "вашего"].includes(w)) formal += 1;
      if (["ты", "тебя", "тебе", "тобой", "твой", "твоя", "твои"].includes(w)) informal += 1;
    }
  }
  if (formal === 0 && informal === 0) return null;
  if (formal === informal) return null;
  return formal > informal ? "formal" : "informal";
}

/** Просьба позвать человека — те же слова, по которым эскалирует агент. */
const HUMAN_REQUEST = /(живо[йг]|человек|оператор|администратор|менеджер)/i;

export function analyzeStyle(messages: ProfileMessage[]): CommunicationStyle {
  const mine = messages.filter((m) => m.direction === "IN" && m.authorType === "PATIENT");
  const texts = mine.map((m) => m.body.trim()).filter((t) => t.length > 0);

  /**
   * Время ответа: наше сообщение → ближайший ответ пациента. Считается только
   * по парам, где ответ действительно последовал: молчание временем ответа
   * не является и медиану улучшать не должно.
   */
  const replies: number[] = [];
  const ordered = [...messages].sort((a, b) => a.at.getTime() - b.at.getTime());
  let askedAt: Date | null = null;
  for (const m of ordered) {
    if (m.direction === "OUT") {
      if (!askedAt) askedAt = m.at;
      continue;
    }
    if (m.authorType !== "PATIENT") continue;
    if (askedAt) {
      replies.push(Math.round((m.at.getTime() - askedAt.getTime()) / 60000));
      askedAt = null;
    }
  }

  const greets = texts.filter((t) => startsWithGreeting(t)).length;

  return {
    messages: mine.length,
    enough: mine.length >= MIN_MESSAGES_FOR_STYLE,
    medianLength: median(texts.map((t) => t.length)),
    medianReplyMinutes: median(replies),
    typicalHour: median(mine.map((m) => m.clinicHour)),
    greetsShare: texts.length === 0 ? null : greets / texts.length,
    address: addressForm(texts),
    voiceOrPhotos: mine.filter((m) => m.hasAttachment).length,
    askedForHuman: texts.filter((t) => HUMAN_REQUEST.test(t)).length,
  };
}

/** Час словами: 19 → «после 19:00». */
function hourLabel(hour: number): string {
  return `${String(Math.round(hour)).padStart(2, "0")}:00`;
}

/** Длительность в минутах словами: 190 → «3 ч». */
function minutesLabel(min: number): string {
  if (min < 60) return `${Math.round(min)} мин`;
  const h = min / 60;
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0).replace(".", ",")} ч`;
  return `${Math.round(h / 24)} дн.`;
}

/**
 * Советы для разговора.
 *
 * Каждый — с основанием, и каждый со своим порогом наблюдений. Это не
 * «портрет личности», а перечень наблюдаемых фактов, переведённых в действие:
 * ничего, кроме того, что видно в данных, здесь не появляется.
 */
export function buildAdvice(
  style: CommunicationStyle,
  visits: PatientProfile["visits"],
  rhythm: PatientProfile["rhythm"],
): { text: string; basis: string }[] {
  const out: { text: string; basis: string }[] = [];

  if (style.enough) {
    if (style.greetsShare !== null && style.greetsShare >= 0.6) {
      out.push({
        text: "Здоровается — поздоровайтесь в ответ.",
        basis: `приветствие в ${Math.round(style.greetsShare * 100)}% сообщений`,
      });
    }
    if (style.address === "formal") {
      out.push({ text: "Обращается на «вы».", basis: "по словам в переписке" });
    } else if (style.address === "informal") {
      out.push({ text: "Пишет на «ты» — можно проще.", basis: "по словам в переписке" });
    }
    if (style.medianLength !== null && style.medianLength <= 40) {
      out.push({
        text: "Пишет коротко — длинный список услуг не прочитает.",
        basis: `обычная длина сообщения ${Math.round(style.medianLength)} знаков`,
      });
    }
    if (style.typicalHour !== null && style.typicalHour >= 19) {
      out.push({
        text: `Пишет вечером — ответ раньше ${hourLabel(style.typicalHour)} ждать не стоит.`,
        basis: `обычное время сообщений — около ${hourLabel(style.typicalHour)}`,
      });
    }
    if (style.typicalHour !== null && style.typicalHour <= 9) {
      out.push({
        text: "Пишет рано утром — утренний ответ застанет его на связи.",
        basis: `обычное время сообщений — около ${hourLabel(style.typicalHour)}`,
      });
    }
    if (style.medianReplyMinutes !== null && style.medianReplyMinutes >= 180) {
      out.push({
        text: "Отвечает не сразу — молчание не значит отказ.",
        basis: `обычно отвечает через ${minutesLabel(style.medianReplyMinutes)}`,
      });
    }
    if (style.voiceOrPhotos >= 3) {
      out.push({
        text: "Присылает голосовые и фото — расшифровка бывает неточной, уточняйте.",
        basis: `вложений в переписке: ${style.voiceOrPhotos}`,
      });
    }
  }

  /**
   * Просьба позвать человека — не стиль, а прямое указание. Порог здесь ниже:
   * дважды попросил живого человека, значит агенту этот разговор не отдавать.
   */
  if (style.askedForHuman >= 2) {
    out.push({
      text: "Просил живого человека — не отдавайте разговор ассистенту.",
      basis: `просил ${style.askedForHuman} раза`,
    });
  }

  if (visits.noShow >= 2) {
    out.push({
      text: "Не доходил дважды и больше — подтвердите запись накануне.",
      basis: `неявок: ${visits.noShow}`,
    });
  }

  if (rhythm.medianDays !== null && rhythm.gaps >= MIN_VISITS_FOR_RHYTHM - 1) {
    out.push({
      text: `Ходит примерно раз в ${Math.round(rhythm.medianDays)} дн. — от этого и предлагайте дату.`,
      basis: `по ${rhythm.gaps} промежуткам между визитами`,
    });
  }

  return out;
}

export function buildPatientProfile(
  visits: ProfileVisit[],
  messages: ProfileMessage[],
  now: Date = new Date(),
): PatientProfile {
  const arrived = visits.filter((v) => v.status === "ARRIVED");
  const graceMs = 24 * 3600 * 1000;

  const serviceAcc = new Map<string, ServicePreference>();
  for (const v of arrived) {
    for (const s of v.services) {
      const acc = serviceAcc.get(s.title) ?? { title: s.title, count: 0, revenue: 0 };
      acc.count += 1;
      acc.revenue += s.amount;
      serviceAcc.set(s.title, acc);
    }
  }

  const staffAcc = new Map<string, number>();
  for (const v of arrived) {
    if (!v.staffName) continue;
    staffAcc.set(v.staffName, (staffAcc.get(v.staffName) ?? 0) + 1);
  }

  const dates = arrived.map((v) => v.at).sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push(Math.round((dates[i].getTime() - dates[i - 1].getTime()) / DAY));
  }

  const paid = arrived.filter((v) => v.revenue > 0);
  const total = arrived.reduce((s, v) => s + v.revenue, 0);

  const all = visits.map((v) => v.at).sort((a, b) => a.getTime() - b.getTime());
  const profileVisits: PatientProfile["visits"] = {
    total: visits.length,
    arrived: arrived.length,
    noShow: visits.filter((v) => v.status === "NO_SHOW").length,
    cancelled: visits.filter((v) => v.status === "CANCELLED").length,
    unmarked: visits.filter(
      (v) =>
        (v.status === "CREATED" || v.status === "CONFIRMED") &&
        v.at.getTime() + graceMs <= now.getTime(),
    ).length,
    firstAt: all[0] ?? null,
    lastAt: all[all.length - 1] ?? null,
  };

  const rhythm = {
    medianDays: median(gaps),
    meanDays: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    gaps: gaps.length,
  };

  const style = analyzeStyle(messages);

  return {
    visits: profileVisits,
    services: [...serviceAcc.values()].sort((a, b) => b.count - a.count || b.revenue - a.revenue),
    staff: [...staffAcc]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    rhythm,
    money: {
      total,
      paidVisits: paid.length,
      // Чек считается по ОПЛАЧЕННЫМ приёмам (§8): сеанс курса и бесплатный
      // приём не идут ни в числитель, ни в знаменатель.
      avgCheck: paid.length === 0 ? null : total / paid.length,
    },
    style,
    advice: buildAdvice(style, profileVisits, rhythm),
  };
}
