import type { Appt } from "@/app/_data/store";
import { busyMinutes, type Interval } from "./metrics/occupancy";
import { CLINIC_DAY, ROOMS, occupies } from "./schedule";

/**
 * Аналитика для кабинета владельца: производительность и часы по сотрудникам,
 * загрузка кабинетов, гипотезы «что улучшить». Считается из стора
 * db.appointments (единый источник, §2). Чистые функции — покрыты тестами.
 */
/*
 * Здесь был прайс по ключевым словам и загрузка кабинетов по зашитому списку
 * «Кабинет 1/2/3». Оба показывали свои числа: остеопатия по 6500 при
 * настоящих 8000, загрузка первого кабинета 8% там, где в отчётах 0% — потому
 * что визиты без кабинета приписывались первому.
 *
 * Цена приходит из YCLIENTS вместе с визитом, загрузка считается общей
 * функцией отчётов (roomOccupancyBetween). Экран не считает метрики сам —
 * иначе у клиники появляется столько правд, сколько экранов.
 */

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
      // Цена визита — только из записи. Запасного прайса по ключевым словам
      // больше нет: он показывал свои числа и расходился с отчётами.
      cur.revenue += a.price ?? 0;
    }
    if (a.status === "no_show") cur.noShow += 1;
    if (occupies(a)) cur.bookedMinutes += a.durationMin;
    map.set(a.doctor, cur);
  }
  return [...map.values()].sort((x, y) => y.revenue - x.revenue);
}

/**
 * Гипотезы и рекомендации из цифр — что улучшить.
 *
 * Загрузку кабинетов принимаем готовой, а не считаем здесь: она приходит из
 * общей функции отчётов. Иначе гипотезы говорили бы про одни числа, а таблица
 * рядом показывала другие.
 */
export function hypotheses(appts: Appt[], loads: { name: string; rate: number }[]): string[] {
  const out: string[] = [];
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
