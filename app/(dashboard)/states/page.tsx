import { FunnelBlock } from "../_components/funnel-block";
import { Section } from "../_components/panel";
import { Readings } from "../_components/readings";
import { RoomDayBoard } from "../_components/room-day";
import { SourceBars } from "../_components/source-bars";
import { StaffTable } from "../_components/staff-table";
import { VisitMixBar } from "../_components/visit-mix-bar";
import { buildFunnel } from "@/lib/metrics/funnel";
import { withSourceShares, withStaffShares } from "@/lib/metrics/summary";
import type { PeriodInfo, RoomDay } from "@/lib/metrics/types";

/**
 * Витрина граничных состояний — служебный экран для визуальной проверки.
 * Фикстуры лежат здесь, а не в `lib/`: это визуальный слой, метрики и моки
 * он не трогает.
 */

export const metadata = { title: "Состояния — Клиника" };

const PERIOD: PeriodInfo = {
  key: "month",
  label: "Месяц",
  from: "2026-07-01T00:00:00.000Z",
  to: "2026-08-01T00:00:00.000Z",
  workingDays: 27,
};

const EMPTY_ROOM: RoomDay = {
  roomId: "room-empty",
  roomName: "Кабинет 3 · БОС и нейромедитация",
  date: "2026-07-22T00:00:00.000Z",
  openMinute: 540,
  closeMinute: 1260,
  intervals: [],
  gaps: [{ startMinute: 540, endMinute: 1260, durationMin: 720 }],
  busyMinutes: 0,
  workingMinutes: 720,
  occupancy: 0,
  periodOccupancy: 0,
};

const BUSY_ROOM: RoomDay = {
  roomId: "room-busy",
  roomName: "Кабинет 2 · IV-терапия и забор анализов",
  date: "2026-07-22T00:00:00.000Z",
  openMinute: 540,
  closeMinute: 1260,
  intervals: [
    {
      appointmentId: "b1",
      startMinute: 540,
      endMinute: 555,
      serviceTitle: "Забор анализов",
      serviceKind: "LAB",
      staffName: "Литвинова О. А.",
      patientLabel: "А. К.",
      isCourseSession: false,
    },
    {
      appointmentId: "b2",
      startMinute: 555,
      endMinute: 660,
      serviceTitle: "IV-терапия, капельница расширенная",
      serviceKind: "IV_THERAPY",
      staffName: "Константинопольская-Ржевская А. В.",
      patientLabel: "Г. И.",
      isCourseSession: true,
    },
    {
      appointmentId: "b3",
      startMinute: 780,
      endMinute: 870,
      serviceTitle: "IV-терапия, капельница",
      serviceKind: "IV_THERAPY",
      staffName: "Ковалёва М. С.",
      patientLabel: "Д. Ф.",
      isCourseSession: true,
    },
  ],
  gaps: [
    { startMinute: 660, endMinute: 780, durationMin: 120 },
    { startMinute: 870, endMinute: 1260, durationMin: 390 },
  ],
  busyMinutes: 210,
  workingMinutes: 720,
  occupancy: 210 / 720,
  periodOccupancy: 0.31,
};

const STAFF = withStaffShares([
  {
    staffId: "s1",
    name: "Константинопольская-Ржевская Анастасия Владимировна",
    specialty: "Врач интегративной медицины, IV-терапия",
    appointments: 1284,
    revenue: 8340500,
  },
  { staffId: "s2", name: "Ковалёва М. С.", specialty: "Врач IV-терапии", appointments: 94, revenue: 611000 },
  {
    staffId: "s3",
    name: "Дорохова Е. В.",
    specialty: "Нейропсихолог, стажировка",
    appointments: 7,
    revenue: 0,
  },
]);

export default function StatesPage() {
  return (
    <>
      <div className="border-groove border-b px-4 py-2.5">
        <h1 className="display text-[15px] leading-tight font-semibold">Граничные состояния</h1>
        <p className="text-label mt-0.5 text-[11px]">
          служебный экран: пустой период, свободный канал, нулевая выручка, длинные имена,
          четырёхзначные приёмы
        </p>
      </div>

      <Section title="Канал без записей" hint="кабинет свободен весь день">
        <RoomDayBoard rooms={[EMPTY_ROOM, BUSY_ROOM]} />
      </Section>

      <div className="border-groove grid grid-cols-1 border-t lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <Section title="Пустой период · воронка">
          <FunnelBlock steps={buildFunnel({ inquiries: 0, booked: 0, arrived: 0 })} />
        </Section>
        <div className="border-groove border-t lg:border-t-0 lg:border-l">
          <Section title="Пустой период · показания">
            <Readings
              money={{
                revenue: 0,
                courseRevenue: 0,
                avgCheck: 0,
                newPatients: 0,
                coursesSold: 0,
                coursesAmount: 0,
              }}
              period={PERIOD}
            />
            <p className="legend mt-4 mb-2">Первичные и повторные</p>
            <VisitMixBar mix={{ first: 0, courseSession: 0, returned: 0, total: 0 }} />
          </Section>
        </div>
      </div>

      <div className="border-groove grid grid-cols-1 border-t lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)]">
        <Section title="Источники · один канал молчит">
          <SourceBars
            sources={withSourceShares([
              { code: "instagram", title: "Instagram", inquiries: 1218, booked: 588 },
              { code: "offline", title: "Пришёл сам", inquiries: 0, booked: 0 },
            ])}
          />
        </Section>
        <div className="border-groove border-t lg:border-t-0 lg:border-l">
          <Section title="Специалисты · длинные имена и нулевая выручка">
            <StaffTable staff={STAFF} />
          </Section>
        </div>
      </div>
    </>
  );
}
