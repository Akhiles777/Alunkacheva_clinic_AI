/**
 * Данные вкладки «Услуги» отчётов — загрузка по услугам (основной разрез, §8).
 * Считается чистой функцией lib/metrics/service-load на мок-данных периода.
 * Остальные вкладки берут данные из lib/mock-metrics (не трогаем).
 */
import { loadByService } from "@/lib/metrics/service-load";
import type { PeriodKey } from "@/lib/metrics/types";

const SERVICE_META: Record<string, string> = {
  iv: "IV-терапия",
  osteo: "Остеопатия",
  bos: "БОС-терапия",
  neuro: "Нейромедитация",
  lab: "Забор анализов",
};

// Кабинеты, где услуга проводится (знаменатель загрузки).
const SERVICE_ROOMS: Record<string, string[]> = {
  iv: ["room-1", "room-2"],
  osteo: ["room-3"],
  bos: ["room-2"],
  neuro: ["room-2"],
  lab: ["room-1"],
};

// Занятые минуты услуги в рабочий день (в сумме по её кабинетам).
const DAILY_BUSY: Record<string, number> = {
  iv: 690,
  osteo: 470,
  bos: 300,
  neuro: 120,
  lab: 180,
};

const PERIOD_DAYS: Record<PeriodKey, number> = { week: 6, month: 27, quarter: 79 };
const ROOM_MINUTES_PER_DAY = 12 * 60; // 09:00–21:00

export interface ServiceLoadRow {
  title: string;
  ratio: number;
  busyMinutes: number;
  availableMinutes: number;
}

export function servicesLoad(period: PeriodKey): ServiceLoadRow[] {
  const days = PERIOD_DAYS[period];
  const roomMinutes: Record<string, number> = {
    "room-1": ROOM_MINUTES_PER_DAY * days,
    "room-2": ROOM_MINUTES_PER_DAY * days,
    "room-3": ROOM_MINUTES_PER_DAY * days,
  };
  const appts = Object.entries(DAILY_BUSY).map(([serviceId, daily]) => ({
    serviceId,
    durationMin: daily * days,
  }));

  return loadByService(appts, SERVICE_ROOMS, roomMinutes).map((l) => ({
    title: SERVICE_META[l.serviceId] ?? l.serviceId,
    ratio: l.ratio,
    busyMinutes: l.busyMinutes,
    availableMinutes: l.availableMinutes,
  }));
}
