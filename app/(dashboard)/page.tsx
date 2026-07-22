import { FunnelBlock } from "./_components/funnel-block";
import { Section } from "./_components/panel";
import { PeriodSwitcher } from "./_components/period-switcher";
import { Readings } from "./_components/readings";
import { RoomDayBoard } from "./_components/room-day";
import { SourceBars } from "./_components/source-bars";
import { StaffTable } from "./_components/staff-table";
import { VisitMixBar } from "./_components/visit-mix-bar";
import { formatDateRange, formatDayLabel, formatDuration } from "@/lib/format";
import { getDashboardMetrics, isPeriodKey, longestFreeWindow } from "@/lib/mock-metrics";

export const metadata = {
  title: "Метрики — Клиника",
};

export default async function DashboardPage({
  searchParams,
}: {
  // В Next 16 searchParams — промис, синхронный доступ убран.
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const requested = Array.isArray(params.period) ? params.period[0] : params.period;
  const period = isPeriodKey(requested) ? requested : "month";

  const metrics = await getDashboardMetrics(period);
  const stripDay = metrics.rooms[0]?.date;
  const bestWindow = Math.max(0, ...metrics.rooms.map(longestFreeWindow));

  return (
    <>
      <div className="border-groove flex flex-wrap items-end justify-between gap-3 border-b px-4 py-2.5">
        <div>
          <h1 className="display text-[15px] leading-tight font-semibold">Метрики клиники</h1>
          <p className="num text-label mt-0.5 text-[11px]">
            {formatDateRange(metrics.period.from, metrics.period.to)} ·{" "}
            {metrics.period.workingDays} рабочих дней
          </p>
        </div>
        <PeriodSwitcher active={metrics.period.key} />
      </div>

      {/* Signature: гравированные шкалы каналов. Единственное место риска. */}
      <Section
        title="Каналы · рабочий день"
        hint={
          stripDay
            ? `${formatDayLabel(stripDay)} · длиннейшее окно ${formatDuration(bestWindow)}`
            : undefined
        }
      >
        <RoomDayBoard rooms={metrics.rooms} />
      </Section>

      <div className="border-groove grid grid-cols-1 border-t lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div>
          <Section title="Воронка" hint="обращение → запись → визит">
            <FunnelBlock steps={metrics.funnelSteps} />
          </Section>
          <Section
            title="Первичные и повторные"
            hint="по состоявшимся визитам"
            className="border-groove border-t"
          >
            <VisitMixBar mix={metrics.visitMix} />

            <dl className="border-groove mt-3.5 grid grid-cols-1 gap-y-1.5 border-t pt-3">
              {[
                {
                  label: "Приёмов в рабочий день",
                  value:
                    metrics.period.workingDays > 0
                      ? (metrics.funnel.arrived / metrics.period.workingDays).toFixed(1).replace(".", ",")
                      : "—",
                },
                {
                  label: "Обращений на один визит",
                  value:
                    metrics.funnel.arrived > 0
                      ? (metrics.funnel.inquiries / metrics.funnel.arrived).toFixed(1).replace(".", ",")
                      : "—",
                },
                {
                  label: "Визитов на проданный курс",
                  value:
                    metrics.money.coursesSold > 0
                      ? (metrics.visitMix.courseSession / metrics.money.coursesSold)
                          .toFixed(1)
                          .replace(".", ",")
                      : "—",
                },
              ].map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-3">
                  <dt className="legend">{row.label}</dt>
                  <dd className="num text-[13px]">{row.value}</dd>
                </div>
              ))}
            </dl>
          </Section>
        </div>

        <div className="border-groove border-t lg:border-t-0 lg:border-l">
          <Section title="Показания" hint="за период">
            <Readings money={metrics.money} period={metrics.period} />
          </Section>
          <Section
            title="Специалисты"
            hint="приёмы и выручка — независимо"
            className="border-groove border-t"
          >
            <StaffTable staff={metrics.staff} />
          </Section>
        </div>
      </div>

      <Section
        title="Обращения по источникам"
        hint="всего · записались · конверсия"
        className="border-groove border-t"
      >
        <SourceBars sources={metrics.sources} />
      </Section>

      <p className="border-groove text-label num border-t px-4 py-2 text-[10px]">
        Проекция YCLIENTS · роллапы пересчитаны{" "}
        {new Date(metrics.updatedAt).toLocaleString("ru-RU", {
          day: "numeric",
          month: "long",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/Moscow",
        })}
      </p>
    </>
  );
}
