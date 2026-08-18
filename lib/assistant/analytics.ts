import type { Patient } from "@/app/_data/store";

/**
 * Локальная аналитика по пациентам для ассистента и страницы «Пациенты».
 * Всё считается на месте, из клиентского стора — персональные данные наружу
 * (в сторонний LLM) не уходят (§5, §7). Когда подключим реальный ИИ, он получит
 * агрегаты отсюда, а не сырые карточки.
 */
const RU_MONTHS: Record<string, number> = {
  января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5,
  июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11,
};

/** Разбирает человекочитаемую метку визита в дату. null — если не удалось. */
export function parseRuDate(label: string, now = new Date()): Date | null {
  const s = label.trim().toLowerCase();
  if (s === "сегодня") return startOfDay(now);
  const ago = /(\d+)\s+(?:дн|день|дня|дней)/.exec(s);
  if (ago) {
    const d = startOfDay(now);
    d.setDate(d.getDate() - Number(ago[1]));
    return d;
  }
  const md = /^(\d{1,2})\s+([а-я]+)(?:\s+(\d{4}))?$/.exec(s);
  if (md) {
    const day = Number(md[1]);
    const month = RU_MONTHS[md[2]];
    if (month === undefined) return null;
    const year = md[3] ? Number(md[3]) : now.getFullYear();
    return new Date(year, month, day);
  }
  return null;
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

const DAY = 24 * 60 * 60 * 1000;

/** Отсортированные по возрастанию даты состоявшихся визитов. */
export function visitDates(patient: Patient, now = new Date()): Date[] {
  return patient.visits
    .filter((v) => v.status === "arrived")
    /**
     * Машинная дата, если она есть, и только иначе — разбор подписи.
     *
     * Разбор подписи спотыкался о «26 августа 2026 г.»: суффикс «г.» не
     * подходил под шаблон, визиты не разбирались, и панель показывала «0 из
     * 7» при полной истории на экране. Демонстрационные записи в сторе
     * подписями и остались, поэтому разбор сохранён как запасной путь.
     */
    .map((v) => (v.at ? new Date(v.at) : parseRuDate(v.date, now)))
    .filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
}

/** Средний интервал между визитами в днях. null — если визитов меньше двух. */
export function avgIntervalDays(dates: Date[]): number | null {
  if (dates.length < 2) return null;
  let total = 0;
  for (let i = 1; i < dates.length; i++) total += (dates[i].getTime() - dates[i - 1].getTime()) / DAY;
  return Math.round(total / (dates.length - 1));
}

export interface PatientVisitStats {
  visitCount: number;
  arrivedCount: number;
  avgIntervalDays: number | null;
  lastVisitDaysAgo: number | null;
  totalSpent: number;
}

export function patientVisitStats(patient: Patient, now = new Date()): PatientVisitStats {
  const dates = visitDates(patient, now);
  const last = dates[dates.length - 1];
  return {
    visitCount: patient.visits.length,
    arrivedCount: dates.length,
    avgIntervalDays: avgIntervalDays(dates),
    /**
     * Сколько ДНЕЙ назад был последний визит.
     *
     * Считалось «полночь сегодня минус момент визита»: приём сегодня в 14:00
     * давал минус четырнадцать часов, округление — «−1 дней назад». Отрицательные
     * дни на экране карточки выглядят как поломка, и справедливо.
     *
     * Сравниваем день с днём: визит сегодня — это ноль, а не минус что-то.
     * Ниже нуля не опускаемся: визит, назначенный на вечер, «минус одним днём»
     * быть не может.
     */
    lastVisitDaysAgo: last
      ? Math.max(0, Math.round((startOfDay(now).getTime() - startOfDay(last).getTime()) / DAY))
      : null,
    totalSpent: patient.visits.reduce((sum, v) => sum + (v.status === "arrived" ? v.amount : 0), 0),
  };
}

export interface ClinicPatientStats {
  total: number;
  primary: number;
  onCourse: number;
  stalled: number;
  noConsent: number;
  withVisits: number;
  avgIntervalDays: number | null;
  bySource: { source: string; count: number }[];
}

function hasTag(p: Patient, tag: string): boolean {
  if (tag === "первичный") return p.firstSeen === "сегодня";
  if (tag === "на курсе") return p.courses.some((c) => c.status === "active");
  if (tag === "выпал из курса") return p.courses.some((c) => c.status === "stalled");
  if (tag === "без согласия") return p.notes.some((n) => n.kind === "NO_CONSENT" && !n.resolved);
  return false;
}

export function clinicPatientStats(patients: Patient[], now = new Date()): ClinicPatientStats {
  const intervals: number[] = [];
  let withVisits = 0;
  const sourceCounts = new Map<string, number>();

  for (const p of patients) {
    const dates = visitDates(p, now);
    if (dates.length > 0) withVisits += 1;
    const avg = avgIntervalDays(dates);
    if (avg !== null) intervals.push(avg);
    sourceCounts.set(p.source, (sourceCounts.get(p.source) ?? 0) + 1);
  }

  return {
    total: patients.length,
    primary: patients.filter((p) => hasTag(p, "первичный")).length,
    onCourse: patients.filter((p) => hasTag(p, "на курсе")).length,
    stalled: patients.filter((p) => hasTag(p, "выпал из курса")).length,
    noConsent: patients.filter((p) => hasTag(p, "без согласия")).length,
    withVisits,
    avgIntervalDays: intervals.length
      ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length)
      : null,
    bySource: [...sourceCounts.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** Русское склонение «дней» для чисел. */
export function pluralDays(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "дня";
  return "дней";
}
