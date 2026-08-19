/**
 * Форма ответа будущего API дашборда (`GET /api/metrics?period=month`).
 *
 * Мок в `lib/mock-metrics.ts` собирается ровно в эту форму, чтобы замена
 * мока на чтение роллапов была заменой одной функции.
 *
 * Все суммы — рубли с копейками (number), все даты — ISO-строки в UTC.
 * Минуты в полосе дня — от полуночи в локальной зоне клиники.
 */

/**
 * Период отчёта.
 *
 * Три скользящих окна — «последние семь дней», «последние тридцать» — и любой
 * календарный месяц строкой «2026-05».
 *
 * Скользящее окно отвечает на вопрос «как идут дела сейчас», календарный
 * месяц — на «сколько было в мае». Это разные вопросы, и подменять один
 * другим нельзя: владелец сравнивает май с мартом, а не «последние тридцать
 * дней» с «предыдущими тридцатью».
 */
export type PeriodKey = "week" | "month" | "quarter" | string;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Календарная неделя вида «w2026-08-10» — понедельник этой недели.
 *
 * Появилась не для красоты. График в кабинете владельца показывает полные
 * недели с понедельника по воскресенье, а отчёт за «Неделю» — последние семь
 * дней до сегодня. На семнадцатое августа это 10–16 против 11–17: разные
 * отрезки, разная выручка — 205 тысяч против 215. Обе цифры верные, но
 * владелец видит два числа под словом «неделя» и справедливо считает это
 * ошибкой платформы.
 *
 * Теперь столбец графика открывает отчёт ровно за свою неделю, и числа
 * совпадают до рубля — потому что это один и тот же вопрос.
 */
const WEEK_RE = /^w(\d{4})-(\d{2})-(\d{2})$/;

/** Календарный месяц вида «2026-05»? */
export function isMonthKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = MONTH_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  // Разумные границы: до 2020 клиники не было, дальше 2100 загадывать незачем.
  return year >= 2020 && year <= 2100;
}

/** Календарная неделя вида «w2026-08-10»? */
export function isWeekKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = WEEK_RE.exec(value);
  if (!m) return false;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Только понедельник: неделя начинается с него, иначе ключ означал бы
  // произвольный семидневный отрезок под видом недели.
  return d.getUTCDay() === 1;
}

/** Разбор периода из адресной строки: чужое значение до расчёта не доходит. */
export function isPeriodKey(value: unknown): value is PeriodKey {
  return (
    value === "week" ||
    value === "month" ||
    value === "quarter" ||
    isMonthKey(value) ||
    isWeekKey(value)
  );
}

const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

/** «2026-05» → «Май 2026». Подпись читает человек. */
export function monthLabel(key: string): string {
  const m = MONTH_RE.exec(key);
  if (!m) return key;
  return `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * Границы календарного месяца в часовом поясе клиники.
 *
 * Считаем в UTC со сдвигом: месяц клиники начинается в 00:00 по Москве, а не
 * по Гринвичу. Разница в три часа переносила бы визиты первого числа в
 * предыдущий месяц.
 */
/**
 * Границы календарной недели в часовом поясе клиники: понедельник 00:00 —
 * следующий понедельник 00:00.
 */
export function weekBounds(key: string, offsetHours = 3): { from: Date; to: Date } {
  const m = WEEK_RE.exec(key);
  if (!m) throw new Error(`Неверная неделя: ${key}`);
  const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), -offsetHours));
  return { from, to: new Date(from.getTime() + 7 * 24 * 3600 * 1000) };
}

const SHORT_MONTHS = [
  "янв", "фев", "мар", "апр", "мая", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];

/** «w2026-08-10» → «10–16 авг». Подпись читает человек. */
export function weekLabel(key: string): string {
  const m = WEEK_RE.exec(key);
  if (!m) return key;
  const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const to = new Date(from.getTime() + 6 * 24 * 3600 * 1000);
  const month = SHORT_MONTHS[to.getUTCMonth()];
  return `${from.getUTCDate()}–${to.getUTCDate()} ${month}`;
}

/** Ключ недели, в которую попадает дата. */
export function weekKeyOf(at: Date, offsetHours = 3): string {
  const local = new Date(at.getTime() + offsetHours * 3600 * 1000);
  const dow = (local.getUTCDay() + 6) % 7; // 0 = понедельник
  const monday = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow),
  );
  const p = (n: number) => String(n).padStart(2, "0");
  return `w${monday.getUTCFullYear()}-${p(monday.getUTCMonth() + 1)}-${p(monday.getUTCDate())}`;
}

export function monthBounds(key: string, offsetHours = 3): { from: Date; to: Date } {
  const m = MONTH_RE.exec(key);
  if (!m) throw new Error(`Неверный месяц: ${key}`);
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const from = new Date(Date.UTC(year, month, 1, -offsetHours));
  const to = new Date(Date.UTC(year, month + 1, 1, -offsetHours));
  return { from, to };
}

export interface PeriodInfo {
  key: PeriodKey;
  label: string;
  /** Включительно, ISO. */
  from: string;
  /** Исключительно, ISO. */
  to: string;
  /** Рабочих дней в периоде — знаменатель средних значений. */
  workingDays: number;
  /**
   * Заполнен ли график клиники.
   *
   * Пустой график — не мелочь: доступное время тогда считается по запасным
   * двенадцати часам в день, и ВСЕ доли загрузки на экране занижены. Молча
   * показывать такие проценты нельзя — по ним решают, нанимать ли людей.
   */
  scheduleFilled: boolean;
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
  /**
   * Сколько записей и визитов пришло именно из переписки (§8, атрибуция).
   *
   * Отдельно от воронки: её шаги показывают полные числа по клинике, а сюда
   * попадает та часть, что дошла из мессенджеров. Без этого разделения
   * конверсия считалась от чужого множества.
   */
  fromDialog?: { booked: number; arrived: number };

  period: PeriodInfo;
  funnel: FunnelCounts;
  funnelSteps: FunnelStep[];
  /**
   * Сколько записей создано в периоде (§8: «записавшиеся» — созданные в
   * периоде). Отчёт показывает и записи, приходящиеся на период: это разные
   * вопросы, и подменять один другим нельзя.
   */
  bookedInPeriod: number;
  money: MoneySummary;
  /**
   * Ведутся ли курсы. Пока их нет, разрез «курсовые/возвраты» показывать
   * нельзя: ноль в нём структурный, а выглядит как измеренная величина.
   */
  coursesTracked: boolean;
  visitMix: VisitMix;
  rooms: RoomDay[];
  sources: SourceStat[];
  staff: StaffStat[];
  /** Когда роллапы последний раз пересчитывались. */
  updatedAt: string;
}
