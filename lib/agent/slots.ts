/**
 * Чистая арифметика свободного времени. Вынесена из работы с базой, чтобы её
 * можно было проверить тестами: именно здесь живёт риск двойной записи.
 */

export interface Busy {
  startAt: Date;
  endAt: Date;
}

/**
 * Пересекаются ли интервалы. Границы строгие: визит 10:00–11:00 и визит
 * 11:00–12:00 идут встык и конфликтом не считаются — иначе половина рабочего
 * дня выпадала бы из предложений на пустом месте.
 */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Начала окон, куда услуга помещается целиком и ни с чем не пересекается. */
export function freeWindows(input: {
  dayStart: Date;
  dayEnd: Date;
  durationMin: number;
  stepMin: number;
  busy: Busy[];
}): Date[] {
  const { dayStart, dayEnd, durationMin, stepMin, busy } = input;
  const out: Date[] = [];
  const durationMs = durationMin * 60_000;

  for (let t = dayStart.getTime(); t + durationMs <= dayEnd.getTime(); t += stepMin * 60_000) {
    const start = new Date(t);
    const end = new Date(t + durationMs);
    if (busy.some((b) => overlaps(start, end, b.startAt, b.endAt))) continue;
    out.push(start);
  }
  return out;
}
