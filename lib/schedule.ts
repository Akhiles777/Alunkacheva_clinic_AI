import { formatMinute, freeGaps, type Interval } from "./metrics/occupancy";
import type { Appt } from "@/app/_data/store";
import type { CabinetNow, FreeWindowRow } from "@/app/_data/today";

/**
 * Единый слой расписания: и «Сегодня», и страница «Расписание», и форма записи
 * считают всё из ОДНОГО источника — стора db.appointments. Раньше это были три
 * несвязанных набора данных, отсюда рассинхрон и записи на занятое время.
 *
 * Всё в минутах от полуночи локальной зоны клиники — функции чистые и покрыты
 * тестами.
 */
export interface RoomDef {
  id: string;
  name: string; // «Кабинет 1»
  direction: string; // «Остеопатия»
}

export const ROOMS: RoomDef[] = [
  { id: "room-1", name: "Кабинет 1", direction: "Процедурный · IV" },
  { id: "room-2", name: "Кабинет 2", direction: "БОС-терапия" },
  { id: "room-3", name: "Кабинет 3", direction: "Остеопатия" },
];

export const CLINIC_DAY: Interval = { startMinute: 9 * 60, endMinute: 21 * 60 };

/** Статусы, занимающие слот. no_show/отмена освобождают время для новой записи. */
const OCCUPYING: Appt["status"][] = ["planned", "confirmed", "arrived"];
export function occupies(a: Appt): boolean {
  return OCCUPYING.includes(a.status);
}

export function roomIntervals(appts: Appt[], roomId: string, excludeId?: string): Interval[] {
  return appts
    .filter((a) => a.roomId === roomId && a.id !== excludeId && occupies(a))
    .map((a) => ({ startMinute: a.startMinute, endMinute: a.startMinute + a.durationMin }));
}

/** Пересекается ли [start, start+dur) с занятыми интервалами кабинета. */
export function hasConflict(
  appts: Appt[],
  roomId: string,
  startMinute: number,
  durationMin: number,
  excludeId?: string,
): boolean {
  const end = startMinute + durationMin;
  return roomIntervals(appts, roomId, excludeId).some(
    (iv) => startMinute < iv.endMinute && end > iv.startMinute,
  );
}

/** Минута дня в таймзоне клиники — реальное «сейчас», не хардкод. */
export function nowMinuteInTz(tz = "Europe/Moscow", at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

export function dateLabelInTz(tz = "Europe/Moscow", at: Date = new Date()): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(at);
}

export function durationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
}

function shortService(title: string): string {
  return title.split(",")[0];
}

function topDoctor(appts: Appt[]): string {
  const counts = new Map<string, number>();
  for (const a of appts) counts.set(a.doctor, (counts.get(a.doctor) ?? 0) + 1);
  let best = "";
  let max = 0;
  for (const [d, n] of counts) {
    if (n > max) {
      best = d;
      max = n;
    }
  }
  return best;
}

const MIN_CABINET_GAP = 15;
const MIN_LIST_WINDOW = 30;

/** Ближайшее к «сейчас» будущее свободное окно кабинета. */
function nextFreeStart(appts: Appt[], roomId: string, now: number, day: Interval): number | null {
  const gaps = freeGaps(roomIntervals(appts, roomId), day, 1).filter((g) => g.endMinute > now);
  if (gaps.length === 0) return null;
  const g = gaps[0];
  const start = Math.max(g.startMinute, now);
  return g.endMinute - start >= MIN_CABINET_GAP ? start : null;
}

/** Карточки кабинетов «Сегодня» — из стора. */
export function buildCabinets(appts: Appt[], now: number, day: Interval = CLINIC_DAY): CabinetNow[] {
  const withStart = ROOMS.map((room) => {
    const roomAppts = appts.filter((a) => a.roomId === room.id);
    const occ = roomAppts.filter(occupies);
    const current = occ.find((a) => a.startMinute <= now && now < a.startMinute + a.durationMin) ?? null;

    const freeStart = nextFreeStart(appts, room.id, now, day);
    let nextFree: CabinetNow["nextFree"] = null;
    if (freeStart !== null) {
      const gaps = freeGaps(roomIntervals(appts, room.id), day, 1).filter((g) => g.endMinute > now);
      const g = gaps[0];
      nextFree = {
        time: formatMinute(freeStart),
        duration: durationLabel(g.endMinute - freeStart),
        soon: false,
      };
    }

    const cabinet: CabinetNow = {
      id: room.id,
      name: room.name,
      direction: room.direction,
      doctor: topDoctor(occ) || "—",
      current: current
        ? {
            proc: shortService(current.service),
            patient: current.patientName,
            isFirstVisit: current.isFirstVisit,
            until: formatMinute(current.startMinute + current.durationMin),
            courseProgress: null,
          }
        : null,
      nextFree,
    };
    return { cabinet, freeStart };
  });

  // «soon» — самое раннее свободное окно по клинике.
  let soonest = Infinity;
  for (const w of withStart) if (w.freeStart !== null && w.freeStart < soonest) soonest = w.freeStart;
  for (const w of withStart) {
    if (w.cabinet.nextFree && w.freeStart === soonest) w.cabinet.nextFree.soon = true;
  }
  return withStart.map((w) => w.cabinet);
}

/** Список свободных окон по всем кабинетам до конца дня. */
export function buildFreeWindows(appts: Appt[], now: number, day: Interval = CLINIC_DAY): FreeWindowRow[] {
  const rows: FreeWindowRow[] = [];
  for (const room of ROOMS) {
    const gaps = freeGaps(roomIntervals(appts, room.id), day, 1).filter(
      (g) => g.endMinute > now && g.endMinute - Math.max(g.startMinute, now) >= MIN_LIST_WINDOW,
    );
    for (const g of gaps) {
      const start = Math.max(g.startMinute, now);
      rows.push({
        id: `${room.id}-${start}`,
        time: formatMinute(start),
        startMinute: start,
        cabName: room.name,
        direction: room.direction,
        duration: durationLabel(g.endMinute - start),
        soon: false,
      });
    }
  }
  rows.sort((a, b) => a.startMinute - b.startMinute);
  if (rows.length) rows[0].soon = true;
  return rows;
}
