/**
 * Мок дашборда.
 *
 * Форма ответа — ровно `DashboardMetrics`, то есть то, что вернёт
 * `GET /api/metrics?period=...` после этапа роллапов. Производные величины
 * (конверсии, доли, занятые минуты, окна, средний чек) здесь НЕ прописаны
 * руками — они считаются теми же чистыми функциями из `lib/metrics`,
 * которыми будет считать API. Иначе мок разъедется с продом незаметно.
 */
import { buildFunnel } from "./metrics/funnel";
import {
  busyMinutes,
  freeGaps,
  longestGap,
  occupancyRate,
  type Interval,
} from "./metrics/occupancy";
import { averageCheck, withSourceShares, withStaffShares } from "./metrics/summary";
import type {
  DashboardMetrics,
  FunnelCounts,
  PeriodKey,
  RoomDay,
  RoomInterval,
  VisitMix,
} from "./metrics/types";

const CLINIC_DAY: Interval = { startMinute: 9 * 60, endMinute: 21 * 60 };

/** День, который показан на полосе кабинетов. Зафиксирован ради детерминизма. */
const STRIP_DATE = "2026-07-22";

interface PeriodDataset {
  label: string;
  from: string;
  to: string;
  workingDays: number;
  funnel: FunnelCounts;
  visitMix: Omit<VisitMix, "total">;
  revenue: number;
  courseRevenue: number;
  newPatients: number;
  coursesSold: number;
  coursesAmount: number;
  /** Загрузка кабинета за весь период — отдельно от загрузки показанного дня. */
  periodOccupancy: Record<string, number>;
  sources: { code: string; title: string; inquiries: number; booked: number }[];
  staff: { staffId: string; name: string; specialty: string; appointments: number; revenue: number }[];
}

const DATASETS: Record<PeriodKey, PeriodDataset> = {
  week: {
    label: "Неделя",
    from: "2026-07-20T00:00:00.000Z",
    to: "2026-07-27T00:00:00.000Z",
    workingDays: 6,
    funnel: { inquiries: 246, booked: 121, arrived: 92 },
    visitMix: { first: 31, courseSession: 44, returned: 17 },
    revenue: 444100,
    courseRevenue: 189500,
    newPatients: 29,
    coursesSold: 8,
    coursesAmount: 462000,
    periodOccupancy: { "room-1": 0.58, "room-2": 0.71, "room-3": 0.49 },
    sources: [
      { code: "instagram", title: "Instagram", inquiries: 97, booked: 47 },
      { code: "whatsapp", title: "WhatsApp", inquiries: 78, booked: 39 },
      { code: "phone", title: "Звонок", inquiries: 40, booked: 19 },
      { code: "site", title: "Сайт", inquiries: 20, booked: 9 },
      { code: "referral", title: "Рекомендация", inquiries: 8, booked: 5 },
      { code: "offline", title: "Пришёл сам", inquiries: 3, booked: 2 },
    ],
    staff: [
      { staffId: "s1", name: "Соколов А. И.", specialty: "Остеопат", appointments: 16, revenue: 112000 },
      { staffId: "s2", name: "Ковалёва М. С.", specialty: "Врач IV-терапии", appointments: 22, revenue: 143000 },
      { staffId: "s3", name: "Ефимова Н. П.", specialty: "БОС-терапевт", appointments: 18, revenue: 90000 },
      { staffId: "s4", name: "Дорохова Е. В.", specialty: "Нейропсихолог", appointments: 10, revenue: 60000 },
      { staffId: "s5", name: "Литвинова О. А.", specialty: "Процедурная сестра", appointments: 26, revenue: 39100 },
    ],
  },
  month: {
    label: "Месяц",
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-08-01T00:00:00.000Z",
    workingDays: 27,
    funnel: { inquiries: 1040, booked: 512, arrived: 392 },
    visitMix: { first: 128, courseSession: 196, returned: 68 },
    revenue: 1886400,
    courseRevenue: 812500,
    newPatients: 128,
    coursesSold: 34,
    coursesAmount: 1964000,
    periodOccupancy: { "room-1": 0.61, "room-2": 0.74, "room-3": 0.52 },
    sources: [
      { code: "instagram", title: "Instagram", inquiries: 412, booked: 198 },
      { code: "whatsapp", title: "WhatsApp", inquiries: 331, booked: 164 },
      { code: "phone", title: "Звонок", inquiries: 168, booked: 79 },
      { code: "site", title: "Сайт", inquiries: 84, booked: 38 },
      { code: "referral", title: "Рекомендация", inquiries: 32, booked: 22 },
      { code: "offline", title: "Пришёл сам", inquiries: 13, booked: 11 },
    ],
    staff: [
      { staffId: "s1", name: "Соколов А. И.", specialty: "Остеопат", appointments: 68, revenue: 476000 },
      { staffId: "s2", name: "Ковалёва М. С.", specialty: "Врач IV-терапии", appointments: 94, revenue: 611000 },
      { staffId: "s3", name: "Ефимова Н. П.", specialty: "БОС-терапевт", appointments: 77, revenue: 385000 },
      { staffId: "s4", name: "Дорохова Е. В.", specialty: "Нейропсихолог", appointments: 41, revenue: 246000 },
      { staffId: "s5", name: "Литвинова О. А.", specialty: "Процедурная сестра", appointments: 112, revenue: 168400 },
    ],
  },
  quarter: {
    label: "Квартал",
    from: "2026-05-01T00:00:00.000Z",
    to: "2026-08-01T00:00:00.000Z",
    workingDays: 79,
    funnel: { inquiries: 3084, booked: 1523, arrived: 1161 },
    visitMix: { first: 372, courseSession: 598, returned: 191 },
    revenue: 5589600,
    courseRevenue: 2418000,
    newPatients: 372,
    coursesSold: 97,
    coursesAmount: 5602000,
    periodOccupancy: { "room-1": 0.59, "room-2": 0.72, "room-3": 0.5 },
    sources: [
      { code: "instagram", title: "Instagram", inquiries: 1218, booked: 588 },
      { code: "whatsapp", title: "WhatsApp", inquiries: 982, booked: 487 },
      { code: "phone", title: "Звонок", inquiries: 498, booked: 235 },
      { code: "site", title: "Сайт", inquiries: 249, booked: 113 },
      { code: "referral", title: "Рекомендация", inquiries: 95, booked: 68 },
      { code: "offline", title: "Пришёл сам", inquiries: 42, booked: 32 },
    ],
    staff: [
      { staffId: "s1", name: "Соколов А. И.", specialty: "Остеопат", appointments: 201, revenue: 1409000 },
      { staffId: "s2", name: "Ковалёва М. С.", specialty: "Врач IV-терапии", appointments: 279, revenue: 1815000 },
      { staffId: "s3", name: "Ефимова Н. П.", specialty: "БОС-терапевт", appointments: 232, revenue: 1160000 },
      { staffId: "s4", name: "Дорохова Е. В.", specialty: "Нейропсихолог", appointments: 118, revenue: 708000 },
      { staffId: "s5", name: "Литвинова О. А.", specialty: "Процедурная сестра", appointments: 331, revenue: 497600 },
    ],
  },
};

type RawInterval = Omit<RoomInterval, "appointmentId">;

/**
 * Расписание показанного дня. Длинные капельницы вперемешку с короткими
 * заборами анализов — так реально выглядит день процедурного кабинета.
 * На дашборде пациент подписан инициалами: полное имя в общий экран не идёт.
 */
const ROOM_PLAN: { roomId: string; roomName: string; intervals: RawInterval[] }[] = [
  {
    roomId: "room-1",
    roomName: "Кабинет 1 · остеопатия",
    intervals: [
      { startMinute: 540, endMinute: 600, serviceTitle: "Остеопатия, приём", serviceKind: "OSTEOPATHY", staffName: "Соколов А. И.", patientLabel: "К. Р.", isCourseSession: false },
      { startMinute: 600, endMinute: 645, serviceTitle: "Остеопатия, коррекция", serviceKind: "OSTEOPATHY", staffName: "Соколов А. И.", patientLabel: "М. Т.", isCourseSession: false },
      { startMinute: 660, endMinute: 720, serviceTitle: "Остеопатия, приём", serviceKind: "OSTEOPATHY", staffName: "Соколов А. И.", patientLabel: "Б. Л.", isCourseSession: false },
      { startMinute: 720, endMinute: 765, serviceTitle: "Остеопатия, коррекция", serviceKind: "OSTEOPATHY", staffName: "Соколов А. И.", patientLabel: "Ж. О.", isCourseSession: false },
      { startMinute: 915, endMinute: 975, serviceTitle: "Остеопатия, приём", serviceKind: "OSTEOPATHY", staffName: "Соколов А. И.", patientLabel: "Н. В.", isCourseSession: false },
      { startMinute: 975, endMinute: 1020, serviceTitle: "Остеопатия, коррекция", serviceKind: "OSTEOPATHY", staffName: "Соколов А. И.", patientLabel: "С. Д.", isCourseSession: false },
      { startMinute: 1035, endMinute: 1095, serviceTitle: "Остеопатия, приём", serviceKind: "OSTEOPATHY", staffName: "Соколов А. И.", patientLabel: "П. А.", isCourseSession: false },
      { startMinute: 1140, endMinute: 1200, serviceTitle: "Остеопатия, приём", serviceKind: "OSTEOPATHY", staffName: "Соколов А. И.", patientLabel: "Т. Е.", isCourseSession: false },
    ],
  },
  {
    roomId: "room-2",
    roomName: "Кабинет 2 · IV-терапия",
    intervals: [
      { startMinute: 540, endMinute: 555, serviceTitle: "Забор анализов", serviceKind: "LAB", staffName: "Литвинова О. А.", patientLabel: "А. К.", isCourseSession: false },
      { startMinute: 555, endMinute: 570, serviceTitle: "Забор анализов", serviceKind: "LAB", staffName: "Литвинова О. А.", patientLabel: "В. Ш.", isCourseSession: false },
      { startMinute: 570, endMinute: 660, serviceTitle: "IV-терапия, капельница", serviceKind: "IV_THERAPY", staffName: "Ковалёва М. С.", patientLabel: "Г. И.", isCourseSession: true },
      { startMinute: 660, endMinute: 750, serviceTitle: "IV-терапия, капельница", serviceKind: "IV_THERAPY", staffName: "Ковалёва М. С.", patientLabel: "Д. Ф.", isCourseSession: true },
      { startMinute: 750, endMinute: 760, serviceTitle: "Забор крови из пальца", serviceKind: "LAB", staffName: "Литвинова О. А.", patientLabel: "Е. Ю.", isCourseSession: false },
      { startMinute: 780, endMinute: 840, serviceTitle: "IV-терапия, экспресс", serviceKind: "IV_THERAPY", staffName: "Ковалёва М. С.", patientLabel: "З. Х.", isCourseSession: true },
      { startMinute: 900, endMinute: 990, serviceTitle: "IV-терапия, капельница", serviceKind: "IV_THERAPY", staffName: "Ковалёва М. С.", patientLabel: "И. Ц.", isCourseSession: true },
      { startMinute: 990, endMinute: 1005, serviceTitle: "Забор анализов", serviceKind: "LAB", staffName: "Литвинова О. А.", patientLabel: "Л. Щ.", isCourseSession: false },
      { startMinute: 1020, endMinute: 1110, serviceTitle: "IV-терапия, капельница", serviceKind: "IV_THERAPY", staffName: "Ковалёва М. С.", patientLabel: "О. Ч.", isCourseSession: true },
      { startMinute: 1110, endMinute: 1170, serviceTitle: "IV-терапия, экспресс", serviceKind: "IV_THERAPY", staffName: "Ковалёва М. С.", patientLabel: "Р. Э.", isCourseSession: true },
    ],
  },
  {
    roomId: "room-3",
    roomName: "Кабинет 3 · БОС и нейромедитация",
    intervals: [
      { startMinute: 540, endMinute: 580, serviceTitle: "БОС-терапия, сеанс", serviceKind: "BIOFEEDBACK", staffName: "Ефимова Н. П.", patientLabel: "У. Я.", isCourseSession: true },
      { startMinute: 585, endMinute: 625, serviceTitle: "БОС-терапия, сеанс", serviceKind: "BIOFEEDBACK", staffName: "Ефимова Н. П.", patientLabel: "Ф. Б.", isCourseSession: true },
      { startMinute: 630, endMinute: 660, serviceTitle: "Нейромедитация", serviceKind: "NEUROMEDITATION", staffName: "Дорохова Е. В.", patientLabel: "Х. Г.", isCourseSession: false },
      { startMinute: 660, endMinute: 700, serviceTitle: "БОС-терапия, сеанс", serviceKind: "BIOFEEDBACK", staffName: "Ефимова Н. П.", patientLabel: "Ц. Д.", isCourseSession: true },
      { startMinute: 780, endMinute: 820, serviceTitle: "БОС-терапия, сеанс", serviceKind: "BIOFEEDBACK", staffName: "Ефимова Н. П.", patientLabel: "Ч. Ж.", isCourseSession: true },
      { startMinute: 825, endMinute: 855, serviceTitle: "Нейромедитация", serviceKind: "NEUROMEDITATION", staffName: "Дорохова Е. В.", patientLabel: "Ш. З.", isCourseSession: false },
      { startMinute: 870, endMinute: 910, serviceTitle: "БОС-терапия, сеанс", serviceKind: "BIOFEEDBACK", staffName: "Ефимова Н. П.", patientLabel: "Щ. И.", isCourseSession: true },
      { startMinute: 1020, endMinute: 1060, serviceTitle: "БОС-терапия, сеанс", serviceKind: "BIOFEEDBACK", staffName: "Ефимова Н. П.", patientLabel: "Э. К.", isCourseSession: true },
      { startMinute: 1065, endMinute: 1095, serviceTitle: "Нейромедитация", serviceKind: "NEUROMEDITATION", staffName: "Дорохова Е. В.", patientLabel: "Ю. Л.", isCourseSession: false },
      { startMinute: 1110, endMinute: 1150, serviceTitle: "БОС-терапия, сеанс", serviceKind: "BIOFEEDBACK", staffName: "Ефимова Н. П.", patientLabel: "Я. М.", isCourseSession: true },
    ],
  },
];

function buildRoomDays(dataset: PeriodDataset): RoomDay[] {
  return ROOM_PLAN.map((room) => {
    const intervals: RoomInterval[] = room.intervals.map((interval, index) => ({
      ...interval,
      appointmentId: `${room.roomId}-${index}`,
    }));

    const busy = busyMinutes(intervals, CLINIC_DAY);
    const working = CLINIC_DAY.endMinute - CLINIC_DAY.startMinute;

    return {
      roomId: room.roomId,
      roomName: room.roomName,
      date: `${STRIP_DATE}T00:00:00.000Z`,
      openMinute: CLINIC_DAY.startMinute,
      closeMinute: CLINIC_DAY.endMinute,
      intervals,
      gaps: freeGaps(intervals, CLINIC_DAY),
      busyMinutes: busy,
      workingMinutes: working,
      occupancy: occupancyRate(busy, working),
      periodOccupancy: dataset.periodOccupancy[room.roomId] ?? 0,
    };
  });
}

function buildMetrics(key: PeriodKey): DashboardMetrics {
  const dataset = DATASETS[key];
  const visitMix: VisitMix = {
    ...dataset.visitMix,
    total: dataset.visitMix.first + dataset.visitMix.courseSession + dataset.visitMix.returned,
  };

  return {
    period: {
      key,
      label: dataset.label,
      from: dataset.from,
      to: dataset.to,
      workingDays: dataset.workingDays,
    },
    funnel: dataset.funnel,
    funnelSteps: buildFunnel(dataset.funnel),
    money: {
      revenue: dataset.revenue,
      courseRevenue: dataset.courseRevenue,
      avgCheck: averageCheck(dataset.revenue, dataset.funnel.arrived),
      newPatients: dataset.newPatients,
      coursesSold: dataset.coursesSold,
      coursesAmount: dataset.coursesAmount,
    },
    visitMix,
    rooms: buildRoomDays(dataset),
    sources: withSourceShares(dataset.sources),
    staff: withStaffShares(dataset.staff),
    updatedAt: `${STRIP_DATE}T05:00:00.000Z`,
  };
}

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "week", label: "Неделя" },
  { key: "month", label: "Месяц" },
  { key: "quarter", label: "Квартал" },
];

export function isPeriodKey(value: unknown): value is PeriodKey {
  return value === "week" || value === "month" || value === "quarter";
}

/**
 * Точка замены: сюда придёт чтение роллапов через Prisma, форма ответа
 * останется прежней.
 */
export async function getDashboardMetrics(period: PeriodKey): Promise<DashboardMetrics> {
  return buildMetrics(period);
}

/** Самое длинное свободное окно дня — для подписи под полосой. */
export function longestFreeWindow(room: RoomDay): number {
  return longestGap(room.intervals, {
    startMinute: room.openMinute,
    endMinute: room.closeMinute,
  });
}
