import { prisma } from "@/lib/db";
import { workingWindowForDay, type Interval } from "@/lib/metrics/occupancy";

/**
 * Рабочее окно клиники на конкретный день: недельное расписание, перекрытое
 * исключением (праздник, санитарный день, укороченный день).
 *
 * Исключения были декорацией: кнопка добавляла строку с датой 1 января, дату
 * и название изменить было нельзя, а прочитать их не пробовал никто — ни
 * запись, ни расчёт загрузки, ни отчёты. Клиника закрывалась на праздник, а
 * платформа продолжала предлагать окна.
 *
 * Само правило перекрытия живёт в чистой функции workingWindowForDay и
 * покрыто тестами; здесь только чтение данных.
 */

export interface DayWindow {
  /** null — клиника в этот день не работает. */
  window: Interval | null;
  /** Название исключения: «Новогодние», «Санитарный день». */
  label: string | null;
}

interface ClinicDaySchedule {
  weekday: number;
  enabled: boolean;
  startMinute: number;
  endMinute: number;
}

/** Дата в зоне клиники как YYYY-MM-DD — ключ исключения. */
export function clinicDateKey(at: Date, timezone = "Europe/Moscow"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Пн..Вс → 1..7, как хранится расписание. */
function weekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

function readSchedule(value: unknown): ClinicDaySchedule[] {
  if (!value || typeof value !== "object") return [];
  const blob = value as { schedule?: unknown };
  return Array.isArray(blob.schedule) ? (blob.schedule as ClinicDaySchedule[]) : [];
}

export async function clinicDayFor(companyId: string, date: Date): Promise<DayWindow> {
  const key = clinicDateKey(date);
  const [setting, exception] = await Promise.all([
    prisma.setting.findUnique({
      where: { companyId_key: { companyId, key: "clinic" } },
      select: { value: true },
    }),
    prisma.clinicScheduleException.findFirst({
      where: { companyId, date: new Date(`${key}T00:00:00.000Z`) },
      select: { isClosed: true, startMinute: true, endMinute: true, label: true },
    }),
  ]);

  const weekday = weekdayOf(key);
  const day = readSchedule(setting?.value).find((d) => d.weekday === weekday);
  const regular =
    day && day.enabled ? { weekday, startMinute: day.startMinute, endMinute: day.endMinute } : null;

  return {
    window: workingWindowForDay(regular, exception),
    label: exception?.label ?? null,
  };
}

/**
 * Даты закрытых дней в периоде. Нужны знаменателю загрузки: если клиника не
 * работала, эти минуты нельзя считать доступными — иначе загрузка занижается
 * ровно на праздники.
 */
export async function closedDatesBetween(
  companyId: string,
  from: Date,
  to: Date,
): Promise<Set<string>> {
  const rows = await prisma.clinicScheduleException.findMany({
    where: { companyId, isClosed: true, date: { gte: from, lte: to } },
    select: { date: true },
  });
  return new Set(rows.map((r) => r.date.toISOString().slice(0, 10)));
}
