/**
 * Данные экрана «Сегодня» — мок в форме будущего ответа API
 * (`GET /api/today`). Живёт в визуальном слое; `lib/metrics/` и
 * `lib/mock-metrics.ts` не трогаем.
 *
 * Форма — под эталонный макет docs/design/Сегодня.dc.html: карточки
 * кабинетов и единый список свободных окон. Окна и «занят до» считаются
 * теми же чистыми функциями occupancy, что и в аналитике, — не руками.
 */
import { freeGaps, formatMinute, type Interval } from "@/lib/metrics/occupancy";
import { resolveRoomId, roomSource, type RoomSource } from "@/lib/rooms";

const CLINIC_DAY: Interval = { startMinute: 9 * 60, endMinute: 21 * 60 };

/** Момент, на который снят экран. Зафиксирован ради детерминизма скриншотов. */
export const NOW_MINUTE = 11 * 60; // 11:00 — в каждом кабинете идёт приём
export const TODAY_ISO = "2026-07-23";

export type ServiceKind =
  | "OSTEOPATHY"
  | "IV_THERAPY"
  | "BIOFEEDBACK"
  | "NEUROMEDITATION"
  | "LAB";

interface PlannedVisit {
  startMinute: number;
  endMinute: number;
  serviceTitle: string;
  serviceKind: ServiceKind;
  staffName: string;
  patientName: string;
  isFirstVisit: boolean;
  courseProgress: { index: number; total: number } | null;
  status: "planned" | "confirmed" | "arrived" | "no_show";
}

export interface CabinetNow {
  id: string;
  name: string; // «Кабинет 1»
  direction: string; // «Остеопатия»
  doctor: string;
  /** Идущий сейчас приём, либо null — кабинет свободен. */
  current: {
    proc: string;
    patient: string;
    isFirstVisit: boolean;
    until: string; // «12:00»
    courseProgress: { index: number; total: number } | null;
  } | null;
  /** Ближайшее свободное окно кабинета. */
  nextFree: { time: string; duration: string; soon: boolean } | null;
}

export interface FreeWindowRow {
  id: string;
  time: string;
  startMinute: number;
  cabName: string;
  direction: string;
  duration: string;
  /** Раньше всех по клинике — выделяется сплошным акцентом. */
  soon: boolean;
}

export interface AttentionItem {
  id: string;
  kind: "escalation" | "unanswered" | "stalled_course" | "unconfirmed";
  title: string;
  detail: string;
  waiting: string;
  urgent: boolean;
}

export interface TodayInquiry {
  id: string;
  name: string;
  channel: "instagram" | "whatsapp";
  preview: string;
  at: string;
  isNewPatient: boolean;
}

export interface TodaySummary {
  revenue: number;
  avgCheck: number;
  scheduled: number;
  firstVisits: number;
  now: string;
}

export interface TodayData {
  date: string;
  nowMinute: number;
  roomSource: RoomSource;
  summary: TodaySummary;
  cabinets: CabinetNow[];
  freeWindows: FreeWindowRow[];
  attention: AttentionItem[];
  inquiries: TodayInquiry[];
}

const ROOM_PLAN: {
  id: string;
  name: string;
  direction: string;
  doctor: string;
  staffDefaultRoomId: string;
  yclientsResourceRoomId: string | null;
  visits: PlannedVisit[];
}[] = [
  {
    id: "room-1",
    name: "Кабинет 1",
    direction: "Остеопатия",
    doctor: "Левин А.",
    staffDefaultRoomId: "room-1",
    yclientsResourceRoomId: "room-1",
    visits: [
      { startMinute: 540, endMinute: 600, serviceTitle: "Остеопатия, приём", serviceKind: "OSTEOPATHY", staffName: "Левин А.", patientName: "Кириллова Р. М.", isFirstVisit: false, courseProgress: null, status: "arrived" },
      { startMinute: 600, endMinute: 645, serviceTitle: "Остеопатия, коррекция", serviceKind: "OSTEOPATHY", staffName: "Левин А.", patientName: "Мещерякова Т. В.", isFirstVisit: false, courseProgress: null, status: "arrived" },
      { startMinute: 660, endMinute: 720, serviceTitle: "Остеопатия, приём", serviceKind: "OSTEOPATHY", staffName: "Левин А.", patientName: "Белов Л. К.", isFirstVisit: true, courseProgress: null, status: "arrived" },
      { startMinute: 915, endMinute: 975, serviceTitle: "Остеопатия, приём", serviceKind: "OSTEOPATHY", staffName: "Левин А.", patientName: "Константинопольская-Ржевская Н. В.", isFirstVisit: true, courseProgress: null, status: "confirmed" },
      { startMinute: 975, endMinute: 1020, serviceTitle: "Остеопатия, коррекция", serviceKind: "OSTEOPATHY", staffName: "Левин А.", patientName: "Седых Д. П.", isFirstVisit: false, courseProgress: null, status: "planned" },
      { startMinute: 1140, endMinute: 1200, serviceTitle: "Остеопатия, приём", serviceKind: "OSTEOPATHY", staffName: "Левин А.", patientName: "Тимофеева Е. А.", isFirstVisit: false, courseProgress: null, status: "confirmed" },
    ],
  },
  {
    id: "room-2",
    name: "Кабинет 2",
    direction: "IV-терапия",
    doctor: "Соколова Е.",
    staffDefaultRoomId: "room-2",
    yclientsResourceRoomId: "room-2",
    visits: [
      { startMinute: 540, endMinute: 555, serviceTitle: "Забор анализов", serviceKind: "LAB", staffName: "Литвинова О. А.", patientName: "Асташов К. И.", isFirstVisit: false, courseProgress: null, status: "arrived" },
      { startMinute: 570, endMinute: 660, serviceTitle: "IV-терапия, капельница", serviceKind: "IV_THERAPY", staffName: "Соколова Е.", patientName: "Гринберг И. Л.", isFirstVisit: false, courseProgress: { index: 6, total: 10 }, status: "arrived" },
      { startMinute: 660, endMinute: 750, serviceTitle: "IV-терапия, капельница", serviceKind: "IV_THERAPY", staffName: "Соколова Е.", patientName: "Дорофеев Ф. Ю.", isFirstVisit: false, courseProgress: { index: 3, total: 8 }, status: "arrived" },
      { startMinute: 780, endMinute: 840, serviceTitle: "IV-терапия, экспресс", serviceKind: "IV_THERAPY", staffName: "Соколова Е.", patientName: "Зимина Х. Ц.", isFirstVisit: false, courseProgress: { index: 9, total: 10 }, status: "confirmed" },
      { startMinute: 900, endMinute: 990, serviceTitle: "IV-терапия, капельница", serviceKind: "IV_THERAPY", staffName: "Соколова Е.", patientName: "Ильин Ц. Щ.", isFirstVisit: false, courseProgress: { index: 2, total: 12 }, status: "planned" },
      { startMinute: 1020, endMinute: 1110, serviceTitle: "IV-терапия, капельница", serviceKind: "IV_THERAPY", staffName: "Соколова Е.", patientName: "Орлов Ч. Э.", isFirstVisit: false, courseProgress: { index: 4, total: 10 }, status: "confirmed" },
    ],
  },
  {
    id: "room-3",
    name: "Кабинет 3",
    direction: "БОС · нейромедитация",
    doctor: "Мороз Д.",
    staffDefaultRoomId: "room-3",
    yclientsResourceRoomId: null,
    visits: [
      { startMinute: 540, endMinute: 580, serviceTitle: "БОС-терапия, сеанс", serviceKind: "BIOFEEDBACK", staffName: "Мороз Д.", patientName: "Устинова Я. Б.", isFirstVisit: false, courseProgress: { index: 5, total: 12 }, status: "arrived" },
      { startMinute: 585, endMinute: 625, serviceTitle: "БОС-терапия, сеанс", serviceKind: "BIOFEEDBACK", staffName: "Мороз Д.", patientName: "Фадеев Б. Г.", isFirstVisit: false, courseProgress: { index: 11, total: 12 }, status: "arrived" },
      { startMinute: 660, endMinute: 700, serviceTitle: "БОС-терапия, сеанс", serviceKind: "BIOFEEDBACK", staffName: "Мороз Д.", patientName: "Цветков Д. Ж.", isFirstVisit: false, courseProgress: { index: 8, total: 12 }, status: "arrived" },
      { startMinute: 780, endMinute: 810, serviceTitle: "Нейромедитация", serviceKind: "NEUROMEDITATION", staffName: "Мороз Д.", patientName: "Шаповалова З. И.", isFirstVisit: false, courseProgress: null, status: "confirmed" },
      { startMinute: 1020, endMinute: 1060, serviceTitle: "БОС-терапия, сеанс", serviceKind: "BIOFEEDBACK", staffName: "Мороз Д.", patientName: "Эрдман К. Л.", isFirstVisit: true, courseProgress: null, status: "planned" },
    ],
  },
];

const ATTENTION: AttentionItem[] = [
  { id: "a1", kind: "escalation", title: "Гринберг И. Л. спрашивает про побочные эффекты", detail: "Агент передал: медицинский вопрос", waiting: "7 мин", urgent: true },
  { id: "a2", kind: "unanswered", title: "Чернышёва Ж. З. ждёт ответа", detail: "WhatsApp · спрашивает про перенос", waiting: "21 мин", urgent: false },
  { id: "a3", kind: "stalled_course", title: "7 курсов без следующей записи", detail: "Дольше всех не ходит Седых Д. П. — сеанс 4 из 10", waiting: "18 дней", urgent: false },
  { id: "a4", kind: "unconfirmed", title: "5 визитов на завтра не подтверждены", detail: "Напоминания ещё не отправлены", waiting: "до 20:00", urgent: false },
];

const INQUIRIES: TodayInquiry[] = [
  { id: "i1", name: "Новый номер +7 916 320-14-08", channel: "instagram", preview: "Здравствуйте! Сколько стоит курс капельниц?", at: "10:42", isNewPatient: true },
  { id: "i2", name: "Белов Л. К.", channel: "whatsapp", preview: "Спасибо, всё подошло. Можно записаться ещё раз?", at: "10:18", isNewPatient: false },
  { id: "i3", name: "Новый номер +7 903 771-52-30", channel: "whatsapp", preview: "А остеопат принимает детей?", at: "09:55", isNewPatient: true },
  { id: "i4", name: "Шаповалова З. И.", channel: "instagram", preview: "Подскажите адрес, я подъезжаю", at: "09:31", isNewPatient: false },
];

function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
}

function shortProc(title: string): string {
  return title.split(",")[0];
}

export function getToday(): TodayData {
  const source = roomSource();
  const now = NOW_MINUTE;

  // Собираем окна по всем кабинетам разом, чтобы отметить самое раннее.
  const rawWindows: { startMinute: number; cabId: string; cabName: string; direction: string; durationMin: number }[] = [];

  const cabinets: CabinetNow[] = ROOM_PLAN.map((plan) => {
    const roomId = resolveRoomId(
      { yclientsResourceRoomId: plan.yclientsResourceRoomId, staffDefaultRoomId: plan.staffDefaultRoomId },
      source,
    );
    // Кабинет без источника кабинета — пустой: приписывать визиты наугад нельзя.
    const visits = roomId ? plan.visits : [];

    const ongoing = visits.find((v) => v.startMinute <= now && v.endMinute > now) ?? null;

    const gaps = freeGaps(visits, CLINIC_DAY).filter((g) => g.endMinute > now);
    for (const gap of gaps) {
      const startMinute = Math.max(gap.startMinute, now);
      const durationMin = gap.endMinute - startMinute;
      if (durationMin >= 30) {
        rawWindows.push({ startMinute, cabId: plan.id, cabName: plan.name, direction: plan.direction, durationMin });
      }
    }
    const firstGap = gaps[0] ?? null;
    const nextFreeStart = firstGap ? Math.max(firstGap.startMinute, now) : null;

    return {
      id: plan.id,
      name: plan.name,
      direction: plan.direction,
      doctor: plan.doctor,
      current: ongoing
        ? {
            proc: shortProc(ongoing.serviceTitle),
            patient: ongoing.patientName,
            isFirstVisit: ongoing.isFirstVisit,
            until: formatMinute(ongoing.endMinute),
            courseProgress: ongoing.courseProgress,
          }
        : null,
      nextFree:
        firstGap && nextFreeStart !== null
          ? { time: formatMinute(nextFreeStart), duration: durationLabel(firstGap.endMinute - nextFreeStart), soon: false }
          : null,
    };
  });

  const sortedWindows = [...rawWindows].sort(
    (a, b) => a.startMinute - b.startMinute || b.durationMin - a.durationMin,
  );
  const soonestStart = sortedWindows[0]?.startMinute ?? -1;

  const freeWindows: FreeWindowRow[] = sortedWindows.map((w, index) => ({
    id: `${w.cabId}-${w.startMinute}-${index}`,
    time: formatMinute(w.startMinute),
    startMinute: w.startMinute,
    cabName: w.cabName,
    direction: w.direction,
    duration: durationLabel(w.durationMin),
    soon: w.startMinute === soonestStart,
  }));

  // Отметить ближайшее окно в карточке того кабинета, где оно самое раннее.
  const soonestCab = sortedWindows[0]?.cabId;
  for (const cab of cabinets) {
    if (cab.id === soonestCab && cab.nextFree) cab.nextFree.soon = true;
  }

  const allVisits = cabinets.flatMap((_, i) =>
    resolveRoomId(
      { yclientsResourceRoomId: ROOM_PLAN[i].yclientsResourceRoomId, staffDefaultRoomId: ROOM_PLAN[i].staffDefaultRoomId },
      source,
    )
      ? ROOM_PLAN[i].visits
      : [],
  );

  return {
    date: TODAY_ISO,
    nowMinute: now,
    roomSource: source,
    summary: {
      revenue: 184200,
      avgCheck: 6140,
      scheduled: allVisits.length,
      firstVisits: allVisits.filter((v) => v.isFirstVisit).length,
      now: formatMinute(now),
    },
    cabinets,
    freeWindows,
    attention: ATTENTION,
    inquiries: INQUIRIES,
  };
}
