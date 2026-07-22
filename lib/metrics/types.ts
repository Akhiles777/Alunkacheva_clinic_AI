/**
 * Форма ответа будущего API дашборда (`GET /api/metrics?period=month`).
 *
 * Мок в `lib/mock-metrics.ts` собирается ровно в эту форму, чтобы замена
 * мока на чтение роллапов была заменой одной функции.
 *
 * Все суммы — рубли с копейками (number), все даты — ISO-строки в UTC.
 * Минуты в полосе дня — от полуночи в локальной зоне клиники.
 */

export type PeriodKey = "week" | "month" | "quarter";

export interface PeriodInfo {
  key: PeriodKey;
  label: string;
  /** Включительно, ISO. */
  from: string;
  /** Исключительно, ISO. */
  to: string;
  /** Рабочих дней в периоде — знаменатель средних значений. */
  workingDays: number;
}

/** Воронка. Считается по определениям: обращение → записались → пришли. */
export interface FunnelCounts {
  /** Inquiry за период: новый диалог, если прошлое сообщение было ≥ 24 ч назад. */
  inquiries: number;
  /** Appointment ≠ CANCELLED по createdAtYclients в периоде. */
  booked: number;
  /** Appointment.status = ARRIVED в периоде. */
  arrived: number;
}

export interface FunnelStep {
  key: keyof FunnelCounts;
  label: string;
  value: number;
  /** Доля от первого шага, 0..1. */
  shareOfTop: number;
  /** Конверсия из предыдущего шага, 0..1. null у первого шага. */
  conversionFromPrev: number | null;
  /** Потеря между шагами в штуках. null у первого шага. */
  lostFromPrev: number | null;
  /** Потеря между шагами, 0..1. null у первого шага. */
  lossRateFromPrev: number | null;
}

export interface MoneySummary {
  /** Признанная выручка: разовые визиты целиком + доля курса на сеанс. */
  revenue: number;
  /** Из них признано по курсовым сеансам. */
  courseRevenue: number;
  /** Выручка / пришедшие. */
  avgCheck: number;
  /** Первое появление телефона в базе за период. */
  newPatients: number;
  /** Продано курсов за период (для сверки с кассой, не выручка). */
  coursesSold: number;
  /** Сумма продаж курсов за период — расходится с revenue, так и должно быть. */
  coursesAmount: number;
}

/**
 * Первичные / повторные. Повторные разделены: визит внутри курса — это не
 * «пациент вернулся», а «идёт по программе».
 */
export interface VisitMix {
  first: number;
  courseSession: number;
  returned: number;
  total: number;
}

export interface RoomInterval {
  appointmentId: string;
  /** Минуты от полуночи, локальная зона клиники. */
  startMinute: number;
  endMinute: number;
  /** Название процедуры — то, что видит администратор на полосе. */
  serviceTitle: string;
  serviceKind: "OSTEOPATHY" | "BIOFEEDBACK" | "IV_THERAPY" | "NEUROMEDITATION" | "LAB" | "OTHER";
  staffName: string;
  patientLabel: string;
  isCourseSession: boolean;
}

/** Свободное окно между занятыми интервалами. */
export interface RoomGap {
  startMinute: number;
  endMinute: number;
  durationMin: number;
}

export interface RoomDay {
  roomId: string;
  roomName: string;
  /** ISO-дата дня, который показан на полосе. */
  date: string;
  /** Границы рабочего дня кабинета. */
  openMinute: number;
  closeMinute: number;
  intervals: RoomInterval[];
  /** Окна не короче порога (по умолчанию 60 мин) — их и ищет администратор. */
  gaps: RoomGap[];
  busyMinutes: number;
  workingMinutes: number;
  /** 0..1. Мелкой цифрой справа, не главный элемент. */
  occupancy: number;
  /** Загрузка за весь период, а не за показанный день. */
  periodOccupancy: number;
}

export interface SourceStat {
  code: string;
  title: string;
  inquiries: number;
  booked: number;
  /** Доля от максимума по источникам — длина бара, 0..1. */
  share: number;
}

export interface StaffStat {
  staffId: string;
  name: string;
  specialty: string;
  appointments: number;
  revenue: number;
  avgCheck: number;
  /** Доли от максимума в колонке — два независимых бара. */
  appointmentsShare: number;
  revenueShare: number;
}

export interface DashboardMetrics {
  period: PeriodInfo;
  funnel: FunnelCounts;
  funnelSteps: FunnelStep[];
  money: MoneySummary;
  visitMix: VisitMix;
  rooms: RoomDay[];
  sources: SourceStat[];
  staff: StaffStat[];
  /** Когда роллапы последний раз пересчитывались. */
  updatedAt: string;
}
