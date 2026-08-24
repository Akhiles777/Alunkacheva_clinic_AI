import type { Appt } from "@/app/_data/store";
import { busyMinutes, type Interval } from "./metrics/occupancy";
import { occupies } from "./schedule";

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
  /**
   * Ключ строки — идентификатор специалиста, а не имя.
   *
   * По имени не различить тёзок: две «Ирины» складывались в одну строку с
   * общей выручкой и общими часами. В остальном коде это правило уже
   * действует, здесь оно было пропущено. Пусто — только если у визита нет
   * идентификатора вовсе.
   */
  staffId: string | null;
  name: string;
  /** Состоявшиеся приёмы: ARRIVED. Одно значение на все экраны. */
  appts: number;
  /** Записи, время которых ещё не прошло: они ни приём, ни неявка. */
  planned: number;
  arrived: number;
  noShow: number;
  bookedMinutes: number;
  revenue: number;
}

/**
 * Что считать «приёмом» специалиста.
 *
 * Здесь было «любой визит периода», в карточке специалиста — «пришли плюс
 * неявки», в отчётах — «пришли». Три числа под одним словом у одного и того же
 * человека: сравнить специалистов было нельзя, а разговаривать с ними — тем
 * более.
 *
 * Приём — это состоявшийся приём, то есть ARRIVED (§8, «Пришедшие»). Неявки и
 * запланированное показываются отдельными числами: они отвечают на другие
 * вопросы и в одно слово не сворачиваются.
 */
export function staffPerformance(
  appts: Appt[],
  /**
   * Проданные курсы: их деньги принадлежат тому, кто курс ведёт.
   *
   * У кассовой операции специалиста нет, а сеансы курса стоят нулём — без
   * этого БОС-терапевт с полусотней сеансов показывала четыре тысячи выручки.
   */
  sales: { staffId?: string | null; staffName: string | null; amount: number }[] = [],
): DoctorStats[] {
  const map = new Map<string, DoctorStats>();
  for (const a of appts) {
    const key = a.staffId ?? a.doctor;
    const cur =
      map.get(key) ??
      { staffId: a.staffId ?? null, name: a.doctor, appts: 0, arrived: 0, noShow: 0, bookedMinutes: 0, revenue: 0, planned: 0 };
    if (a.status === "arrived") cur.appts += 1;
    if (a.status === "planned" || a.status === "confirmed") cur.planned += 1;
    if (a.status === "arrived") {
      cur.arrived += 1;
      // Цена визита — только из записи. Запасного прайса по ключевым словам
      // больше нет: он показывал свои числа и расходился с отчётами.
      cur.revenue += a.price ?? 0;
    }
    if (a.status === "no_show") cur.noShow += 1;
    if (occupies(a)) cur.bookedMinutes += a.durationMin;
    map.set(key, cur);
  }
  /**
   * Деньги за курс — в ту же строку, где стоят приёмы этого специалиста.
   *
   * Ключом служит идентификатор, но у визита его может не быть: разные экраны
   * собирают визиты разными запросами, и один из них идентификатор не отдавал.
   * Тогда строка визитов заведена под именем, а продажа приходит с
   * идентификатором — и один человек показывался двумя строками: «0 приёмов,
   * 228 000 ₽» и «63 приёма, 5 800 ₽». Это и увидел заказчик.
   *
   * Поэтому ищем строку сначала по идентификатору, потом по имени — но по
   * имени только тогда, когда такая строка ровно одна. Двое тёзок в разрезе
   * остаются двумя строками: приписать деньги наугад одному из них хуже, чем
   * завести им отдельную строку.
   */
  const rowsByName = new Map<string, string[]>();
  for (const [key, row] of map) {
    rowsByName.set(row.name, [...(rowsByName.get(row.name) ?? []), key]);
  }

  for (const s of sales) {
    // Курс без специалиста приписывать некому: его деньги показываются отдельно.
    if (!s.staffId && !s.staffName) continue;
    const sameName = s.staffName ? (rowsByName.get(s.staffName) ?? []) : [];
    const key =
      (s.staffId && map.has(s.staffId) ? s.staffId : null) ??
      (sameName.length === 1 ? sameName[0] : null) ??
      s.staffId ??
      s.staffName!;
    const cur =
      map.get(key) ??
      {
        staffId: s.staffId ?? null,
        name: s.staffName ?? "специалист не указан",
        appts: 0,
        arrived: 0,
        noShow: 0,
        bookedMinutes: 0,
        revenue: 0,
        planned: 0,
      };
    // Деньги без приёма: приёмом были сеансы курса, они уже посчитаны.
    cur.revenue += s.amount;
    map.set(key, cur);
    if (!rowsByName.get(cur.name)?.includes(key)) {
      rowsByName.set(cur.name, [...(rowsByName.get(cur.name) ?? []), key]);
    }
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
