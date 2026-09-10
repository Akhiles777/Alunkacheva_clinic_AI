/**
 * Собрать окно: какой перенос освободит нужное время.
 *
 * Капельница занимает 90 минут, окна нарезаны по 40–60. Пациент звонит, окна
 * формально есть, поставить некуда — администратор отказывает. Это прямые
 * потерянные деньги, и почти всегда рядом стоит запись, которую человек и сам
 * готов подвинуть на двадцать минут.
 *
 * Система только ПРЕДЛАГАЕТ. Перенос делает администратор, договорившись с
 * пациентом: это чужие люди и чужое время, и двигать их молча нельзя ни при
 * каких условиях.
 */

export interface Booking {
  id: string;
  patientId: string;
  patientName: string;
  staffId: string;
  roomId: string | null;
  serviceId: string | null;
  serviceTitle: string;
  startMinute: number;
  durationMin: number;
  /** Первичный визит — такого не двигаем никогда. */
  isFirstVisit: boolean;
  /** Ходит регулярно: курс или повторные визиты. */
  regular: boolean;
  /** Дата визита: завтрашние не трогаем, договориться не успеют. */
  date: Date;
}

export interface Interval {
  startMinute: number;
  endMinute: number;
}

export interface AssemblyContext {
  /** Кабинет, в котором ищем место. */
  roomId: string;
  /** Сколько минут нужно. */
  needMin: number;
  /** Рабочие часы кабинета и клиники в этот день. */
  day: Interval;
  /** Занятость этого кабинета — все записи, включая переносимую. */
  roomBusy: (Interval & { id: string })[];
  /** Занятость специалистов — он может вести приём и в другом кабинете. */
  staffBusy: Record<string, (Interval & { id: string })[]>;
  /** Смена специалиста в этот день. Пусто — не знаем, и тогда не предлагаем. */
  staffShift: Record<string, Interval | null>;
  /** Кабинеты, где услуга может проводиться. Пусто — ограничений нет. */
  serviceRooms: Record<string, string[]>;
  /** Сколько минут от начала суток «сейчас», если день сегодняшний. */
  nowMinute: number | null;
  /** Пациенты, которым и так пишут: их не трогаем. */
  alreadyCalled: Set<string>;
}

export interface Move {
  booking: Booking;
  /** Куда предлагаем сдвинуть. */
  toStartMinute: number;
  /** На сколько минут сдвигается — по этому сортируются предложения. */
  shiftMin: number;
  /** Какое окно получится после переноса. */
  freed: Interval;
}

/** Дальше этого не двигаем: два часа — уже другой день для человека. */
export const MAX_SHIFT_MIN = 120;
/**
 * Ближе этого дня не предлагаем: договориться не успеют.
 *
 * Два — значит «не сегодня и не завтра»: завтрашний день у человека уже
 * распланирован, и просьба подвинуться воспринимается как «нас не считают».
 */
export const MIN_DAYS_AHEAD = 2;
/** Больше трёх предложений человек не читает. */
export const MAX_SUGGESTIONS = 3;

function overlaps(a: Interval, b: Interval): boolean {
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute;
}

function inside(outer: Interval, inner: Interval): boolean {
  return inner.startMinute >= outer.startMinute && inner.endMinute <= outer.endMinute;
}

/**
 * Можно ли поставить эту запись на новое время, ничего не сломав.
 *
 * Каждая проверка — отдельная причина отказать, и каждая проверяется тестом:
 * предложение, которое ломает чужую запись, хуже отсутствия предложения.
 */
export function moveIsSafe(
  booking: Booking,
  toStartMinute: number,
  ctx: AssemblyContext,
): boolean {
  const moved: Interval = {
    startMinute: toStartMinute,
    endMinute: toStartMinute + booking.durationMin,
  };

  // Новое время не в прошлом.
  if (ctx.nowMinute !== null && moved.startMinute < ctx.nowMinute) return false;

  // Рабочие часы кабинета и клиники.
  if (!inside(ctx.day, moved)) return false;

  // Смена специалиста. Не знаем её — не предлагаем: догадка о чужом графике
  // стоит человеку зря потраченного дня.
  const shift = ctx.staffShift[booking.staffId];
  if (!shift) return false;
  if (!inside(shift, moved)) return false;

  // Кабинет: услуга должна там проводиться.
  const rooms = booking.serviceId ? (ctx.serviceRooms[booking.serviceId] ?? []) : [];
  if (booking.roomId && rooms.length > 0 && !rooms.includes(booking.roomId)) return false;

  // Не наезжает на другую запись в том же кабинете.
  for (const busy of ctx.roomBusy) {
    if (busy.id === booking.id) continue;
    if (overlaps(moved, busy)) return false;
  }

  // Не наезжает на другую запись самого специалиста — он мог вести приём и в
  // другом кабинете.
  for (const busy of ctx.staffBusy[booking.staffId] ?? []) {
    if (busy.id === booking.id) continue;
    if (overlaps(moved, busy)) return false;
  }

  return true;
}

/** Кого вообще можно предлагать двигать. */
export function movable(booking: Booking, ctx: AssemblyContext, now: Date): boolean {
  // Первичного не двигаем никогда: человека, который идёт впервые, нельзя
  // просить перенести ради другого.
  if (booking.isFirstVisit) return false;
  // Тот, кто ходит редко и случайно, договариваться не обязан.
  if (!booking.regular) return false;
  // Завтра — поздно: договориться не успеют.
  const days = Math.round(
    (startOfDay(booking.date).getTime() - startOfDay(now).getTime()) / (24 * 3600 * 1000),
  );
  if (days < MIN_DAYS_AHEAD) return false;
  // Кому и так пишут — не трогаем: два повода в одном звонке путают обоих.
  if (ctx.alreadyCalled.has(booking.patientId)) return false;
  return true;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Предложения: один перенос — одно собранное окно.
 *
 * Цепочки из двух и более переносов не строим намеренно: они хрупкие, и
 * договориться нужно уже с двумя людьми. Сортируем по величине сдвига —
 * чем меньше двигаем чужой день, тем охотнее согласятся.
 */
export function assembleWindow(
  bookings: Booking[],
  ctx: AssemblyContext,
  now: Date = new Date(),
): Move[] {
  const moves: Move[] = [];

  for (const booking of bookings) {
    if (booking.roomId !== ctx.roomId) continue;
    if (!movable(booking, ctx, now)) continue;

    /**
     * Пробуем сдвиги с шагом в пять минут в обе стороны, начиная с меньших:
     * первый подошедший и есть лучший для этой записи.
     */
    for (let shift = 5; shift <= MAX_SHIFT_MIN; shift += 5) {
      for (const to of [booking.startMinute + shift, booking.startMinute - shift]) {
        if (!moveIsSafe(booking, to, ctx)) continue;

        const freed = freedWindow(booking, to, ctx);
        if (!freed || freed.endMinute - freed.startMinute < ctx.needMin) continue;

        moves.push({ booking, toStartMinute: to, shiftMin: shift, freed });
        break;
      }
      if (moves.some((m) => m.booking.id === booking.id)) break;
    }
  }

  return moves.sort((a, b) => a.shiftMin - b.shiftMin).slice(0, MAX_SUGGESTIONS);
}

/**
 * Какое непрерывное окно освободится в кабинете, если подвинуть эту запись.
 *
 * Считаем по реальной занятости после переноса, а не «длительность записи
 * плюс соседний зазор»: рядом может стоять ещё одна запись, и тогда окна не
 * получится вовсе.
 */
export function freedWindow(
  booking: Booking,
  toStartMinute: number,
  ctx: AssemblyContext,
): Interval | null {
  const after = ctx.roomBusy
    .filter((b) => b.id !== booking.id)
    .concat([
      {
        id: booking.id,
        startMinute: toStartMinute,
        endMinute: toStartMinute + booking.durationMin,
      },
    ])
    .sort((a, b) => a.startMinute - b.startMinute);

  let cursor = ctx.day.startMinute;
  let best: Interval | null = null;
  for (const busy of after) {
    if (busy.startMinute > cursor) {
      const gap = { startMinute: cursor, endMinute: busy.startMinute };
      if (!best || gap.endMinute - gap.startMinute > best.endMinute - best.startMinute) best = gap;
    }
    cursor = Math.max(cursor, busy.endMinute);
  }
  if (ctx.day.endMinute > cursor) {
    const gap = { startMinute: cursor, endMinute: ctx.day.endMinute };
    if (!best || gap.endMinute - gap.startMinute > best.endMinute - best.startMinute) best = gap;
  }
  return best;
}
