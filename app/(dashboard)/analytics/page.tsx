import Link from "next/link";
import { getDashboardMetricsDb, getServicesLoadDb } from "@/lib/server/analytics";
import { getSession } from "@/lib/server/session";
import { formatDuration, formatMoney, formatMoneyPrecise, formatNumber, formatPercent } from "@/lib/format";
import { isMonthKey, isPeriodKey, monthLabel, type PeriodKey } from "@/lib/metrics/types";

export const metadata = { title: "Отчёты" };

const TABS = [
  { id: "funnel", label: "Воронка" },
  { id: "visits", label: "Визиты" },
  { id: "sources", label: "Источники" },
  { id: "staff", label: "Специалисты" },
  { id: "services", label: "Услуги" },
  { id: "rooms", label: "Кабинеты" },
];
const PERIODS: { id: PeriodKey; label: string }[] = [
  { id: "week", label: "Неделя" },
  { id: "month", label: "Месяц" },
  { id: "quarter", label: "Квартал" },
];

/**
 * Последние календарные месяцы для выбора.
 *
 * Скользящее окно отвечает на вопрос «как идут дела сейчас», календарный
 * месяц — на «сколько было в мае». Владелец сравнивает май с мартом, а не
 * «последние тридцать дней» с предыдущими тридцатью, и без такого выбора
 * ответить на его вопрос было нечем.
 */
function recentMonths(now: Date, count = 18): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const id = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    out.push({ id, label: monthLabel(id) });
  }
  return out;
}

function Bar({ value, tone = "accent" }: { value: number; tone?: "accent" | "muted" }) {
  return (
    <div className="bg-list-gap h-2 flex-1 overflow-hidden rounded-pill">
      <div
        className={`h-full rounded-pill ${tone === "accent" ? "bg-accent" : "bg-border-strong"}`}
        style={{ width: `${Math.max(value * 100, 0)}%` }}
      />
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-border bg-surface rounded-xl border p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3 max-md:flex-col max-md:items-start max-md:gap-1">
        <h2 className="text-sm font-medium">{title}</h2>
        {hint ? <span className="text-text-subtle text-xs">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const rawPeriod = Array.isArray(sp.period) ? sp.period[0] : sp.period;
  const period: PeriodKey = isPeriodKey(rawPeriod) ? rawPeriod : "month";
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab = TABS.some((t) => t.id === rawTab) ? (rawTab as string) : "funnel";

  const session = await getSession();
  const [m, servicesLoad] = await Promise.all([
    getDashboardMetricsDb(session.companyId, period),
    getServicesLoadDb(session.companyId, period),
  ]);
  const q = (t: string, p: PeriodKey) => `/analytics?tab=${t}&period=${p}`;

  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3 max-md:flex-col max-md:items-stretch max-md:gap-2.5">
          <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Отчёты</h1>
          <div className="border-border inline-flex overflow-hidden rounded-md border max-md:flex">
            {PERIODS.map((p, i) => (
              <Link
                key={p.id}
                href={q(tab, p.id)}
                className={`px-3 py-1.5 text-sm max-md:flex-1 max-md:py-2.5 max-md:text-center ${i > 0 ? "border-border border-l" : ""} ${
                  period === p.id ? "bg-accent-tint text-accent-text font-medium" : "text-text-muted hover:bg-hover"
                }`}
              >
                {p.label}
              </Link>
            ))}
          </div>
          {/*
            Выбор месяца — обычный список, а не календарь: месяцев немного, и
            выбрать «Май 2026» одним движением быстрее, чем указывать даты.
          */}
          <form method="get" className="flex items-center gap-2">
            <input type="hidden" name="tab" value={tab} />
            <select
              name="period"
              defaultValue={isMonthKey(period) ? period : ""}
              className="border-border-input bg-surface rounded-md border px-2.5 py-1.5 text-sm outline-none max-md:flex-1"
              aria-label="Отчёт за месяц"
            >
              <option value="">Выбрать месяц…</option>
              {recentMonths(new Date()).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="border-border text-text hover:bg-hover rounded-md border px-3 py-1.5 text-sm"
            >
              Показать
            </button>
          </form>
        </div>
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={q(t.id, period)}
              className={`rounded-md px-2.5 py-1 text-xs ${
                tab === t.id ? "bg-nav-active text-accent-text font-medium" : "text-text-muted hover:bg-hover"
              }`}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="max-w-[820px]">
          {tab === "funnel" ? (
            <Card
              title="Воронка обращений"
              hint="обращение — сообщение после суток молчания (§8)"
            >
              <ul className="flex flex-col gap-4">
                {m.funnelSteps.map((s) => (
                  <li key={s.key}>
                    <div className="flex items-baseline justify-between gap-3 max-md:flex-col max-md:items-start max-md:gap-1">
                      <span className="text-sm">{s.label}</span>
                      <span className="num text-sm font-medium">{formatNumber(s.value)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3">
                      <Bar value={s.shareOfTop} />
                      <span className="num text-text-subtle w-28 flex-none text-right text-2xs">
                        {s.conversionFromPrev === null
                          ? "100%"
                          : `${formatPercent(s.conversionFromPrev)} · −${formatNumber(s.lostFromPrev ?? 0)}`}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              {/*
                Записи, созданные в периоде, — вторая половина ответа на вопрос
                «сколько записалось». Шаг воронки считает приёмы, приходящиеся
                на период; человек мог записаться в августе на сентябрь.
              */}
              <div className="border-border-soft text-text-muted mt-4 border-t pt-3 text-xs">
                Записалось за период (по дате записи, а не приёма):{" "}
                <span className="num text-text font-medium">{formatNumber(m.bookedInPeriod)}</span>
              </div>
            </Card>
          ) : null}

          {tab === "visits" ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
                <Card title="Выручка">
                  <div className="readout text-2xl">{formatMoney(m.money.revenue)}</div>
                  <div className="text-text-subtle mt-1 text-xs">
                    курсами {formatMoney(m.money.courseRevenue)}
                  </div>
                </Card>
                <Card title="Средний чек">
                  <div className="readout text-2xl">{formatMoneyPrecise(m.money.avgCheck)}</div>
                </Card>
                <Card title="Новые пациенты">
                  <div className="readout text-2xl">{formatNumber(m.money.newPatients)}</div>
                </Card>
              </div>
              <Card title="Первичные и повторные" hint="повторные разделены на курсовые и возвраты">
                <div className="border-border flex h-8 overflow-hidden rounded-md border">
                  <div className="bg-accent" style={{ width: `${(m.visitMix.first / m.visitMix.total) * 100}%` }} />
                  <div className="bg-border-strong" style={{ width: `${(m.visitMix.courseSession / m.visitMix.total) * 100}%` }} />
                  <div className="bg-list-gap" style={{ width: `${(m.visitMix.returned / m.visitMix.total) * 100}%` }} />
                </div>
                <div className="text-text-muted mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                  <span>Первичные <span className="num text-text font-medium">{m.visitMix.first}</span></span>
                  <span>Курсовые <span className="num text-text font-medium">{m.visitMix.courseSession}</span></span>
                  <span>Возвраты <span className="num text-text font-medium">{m.visitMix.returned}</span></span>
                </div>
              </Card>
            </div>
          ) : null}

          {tab === "sources" ? (
            <Card title="Обращения по источникам" hint="звонки из журнала учтены в «Звонок»">
              <ul className="flex flex-col gap-3">
                {m.sources.map((s) => (
                  <li key={s.code} className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3">
                    <span className="truncate text-sm">{s.title}</span>
                    <div className="flex items-center gap-3">
                      <Bar value={s.share} />
                      <span className="num text-text-subtle w-32 flex-none text-right text-2xs">
                        {formatNumber(s.inquiries)} → {formatNumber(s.booked)} ({formatPercent(s.inquiries ? s.booked / s.inquiries : 0)})
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {tab === "staff" ? (
            <Card title="Приёмы и выручка по специалистам" hint="приёмы и выручка — независимо">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-sm">
                  <thead>
                    <tr className="border-border-soft border-b text-left">
                      <th className="text-text-subtle py-2 pr-3 text-2xs font-normal">Специалист</th>
                      <th className="text-text-subtle w-[28%] py-2 pr-3 text-2xs font-normal">Приёмы</th>
                      <th className="text-text-subtle w-[32%] py-2 pr-3 text-2xs font-normal">Выручка</th>
                      <th className="text-text-subtle py-2 text-right text-2xs font-normal">Чек</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.staff.map((s) => (
                      <tr key={s.staffId} className="border-border-soft border-b last:border-b-0">
                        <td className="py-2.5 pr-3 align-middle">
                          <div className="truncate">{s.name}</div>
                          <div className="text-text-subtle text-2xs">{s.specialty}</div>
                        </td>
                        <td className="py-2.5 pr-3 align-middle">
                          <div className="flex items-center gap-2">
                            <Bar value={s.appointmentsShare} tone="muted" />
                            <span className="num w-9 flex-none text-right text-xs">{s.appointments}</span>
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 align-middle">
                          <div className="flex items-center gap-2">
                            <Bar value={s.revenueShare} />
                            <span className="num w-[86px] flex-none text-right text-xs">{formatMoney(s.revenue)}</span>
                          </div>
                        </td>
                        <td className="num text-text-muted py-2.5 text-right align-middle text-xs whitespace-nowrap">
                          {formatMoneyPrecise(s.avgCheck)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {tab === "services" ? (
            <Card title="Загрузка по услугам" hint="основной разрез: занято / доступно в кабинетах услуги">
              <ul className="flex flex-col gap-3.5">
                {servicesLoad.map((s) => (
                  <li key={s.title}>
                    <div className="flex items-baseline justify-between gap-3 max-md:flex-col max-md:items-start max-md:gap-1">
                      <span className="text-sm">{s.title}</span>
                      <span className="num text-sm font-medium">{formatPercent(s.ratio)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3">
                      <Bar value={s.ratio} />
                      <span className="num text-text-subtle w-40 flex-none text-right text-2xs">
                        {formatDuration(s.busyMinutes)} из {formatDuration(s.availableMinutes)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {tab === "rooms" ? (
            <Card title="Загрузка кабинетов" hint="дополнительный разрез — по кабинетам">
              <ul className="flex flex-col gap-3.5">
                {m.rooms.map((r) => (
                  <li key={r.roomId}>
                    <div className="flex items-baseline justify-between gap-3 max-md:flex-col max-md:items-start max-md:gap-1">
                      <span className="text-sm">{r.roomName}</span>
                      <span className="num text-sm font-medium">{formatPercent(r.periodOccupancy)}</span>
                    </div>
                    <div className="mt-1.5">
                      <Bar value={r.periodOccupancy} />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
