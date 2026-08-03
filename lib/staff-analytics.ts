import type { Appt } from "@/app/_data/store";
import { busyMinutes, type Interval } from "./metrics/occupancy";
import { CLINIC_DAY, ROOMS, occupies } from "./schedule";

/**
 * Аналитика для кабинета владельца: производительность и часы по сотрудникам,
 * загрузка кабинетов, гипотезы «что улучшить». Считается из стора
 * db.appointments (единый источник, §2). Чистые функции — покрыты тестами.
 */
const PRICE_RULES: { kw: string; price: number }[] = [
  { kw: "капельниц", price: 6500 },
  { kw: "экспресс", price: 4500 },
  { kw: "остеопат", price: 6500 },
  { kw: "бос", price: 5000 },
  { kw: "нейромед", price: 6000 },
  { kw: "забор", price: 1200 },
];

export function priceOf(service: string): number {
  const s = service.toLowerCase();
  return PRICE_RULES.find((r) => s.includes(r.kw))?.price ?? 5000;
}

export interface DoctorStats {
  name: string;
  appts: number;
  arrived: number;
  noShow: number;
  bookedMinutes: number;
  revenue: number;
}

export function staffPerformance(appts: Appt[]): DoctorStats[] {
  const map = new Map<string, DoctorStats>();
  for (const a of appts) {
    const cur =
      map.get(a.doctor) ??
      { name: a.doctor, appts: 0, arrived: 0, noShow: 0, bookedMinutes: 0, revenue: 0 };
    cur.appts += 1;
    if (a.status === "arrived") {
      cur.arrived += 1;
      // Цена визита — из записи (пришла из цены услуги в настройках); keyword-map — фоллбэк.
      cur.revenue += a.price ?? priceOf(a.service);
    }
    if (a.status === "no_show") cur.noShow += 1;
    if (occupies(a)) cur.bookedMinutes += a.durationMin;
    map.set(a.doctor, cur);
  }
  return [...map.values()].sort((x, y) => y.revenue - x.revenue);
}

export interface RoomLoad {
  roomId: string;
  name: string;
  busyMinutes: number;
  workingMinutes: number;
  rate: number; // 0..1
}

export function roomLoad(appts: Appt[], day: Interval = CLINIC_DAY): RoomLoad[] {
  const workingMinutes = day.endMinute - day.startMinute;
  return ROOMS.map((room) => {
    const intervals = appts
      .filter((a) => a.roomId === room.id && occupies(a))
      .map((a) => ({ startMinute: a.startMinute, endMinute: a.startMinute + a.durationMin }));
    const busy = busyMinutes(intervals, day);
    return {
      roomId: room.id,
      name: room.name,
      busyMinutes: busy,
      workingMinutes,
      rate: workingMinutes > 0 ? Math.min(busy / workingMinutes, 1) : 0,
    };
  });
}

/** Гипотезы и рекомендации из цифр — что улучшить. */
export function hypotheses(appts: Appt[]): string[] {
  const out: string[] = [];
  const loads = roomLoad(appts);
  for (const l of loads) {
    const pct = Math.round(l.rate * 100);
    if (pct < 45) {
      out.push(`${l.name} загружен на ${pct}% — есть свободные окна под дополнительные записи или акцию.`);
    } else if (pct >= 80) {
      out.push(`${l.name} загружен на ${pct}% — риск очередей; рассмотрите второго специалиста или продление смены.`);
    }
  }
  for (const s of staffPerformance(appts)) {
    if (s.noShow > 0) {
      out.push(`У «${s.name}» ${s.noShow} неявок — подтверждайте записи за день и напоминанием в мессенджере.`);
    }
  }
  if (out.length === 0) out.push("Явных перекосов по загрузке и неявкам нет — работа сбалансирована.");
  return out;
}
