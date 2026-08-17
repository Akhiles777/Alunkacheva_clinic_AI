import { formatMoney } from "@/lib/format";
import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { getOwnerReport, getWeeklyDynamics } from "./actions";
import { OwnerAssistant } from "./owner-assistant";
import { WeeklyCharts } from "./weekly-charts";

export const metadata = { title: "Владелец" };

function Tile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="border-border bg-surface rounded-xl border px-4 py-3.5">
      <div className="text-text-subtle text-2xs">{label}</div>
      <div className="readout mt-1 text-xl">{value}</div>
      {hint ? <div className="text-text-subtle mt-0.5 text-2xs">{hint}</div> : null}
    </div>
  );
}

export default async function OwnerPage() {
  /**
   * Отказ показываем понятной страницей, а не красным экраном ошибки: без
   * права на выручку этот раздел просто не для этого сотрудника, и это не
   * поломка.
   */
  const session = await getSession();
  if (!(await can(session, "VIEW_REVENUE"))) {
    return (
      <div className="px-7 py-8 max-md:px-5">
        <div className="border-border bg-surface max-w-[560px] rounded-xl border p-5">
          <p className="text-md font-medium">Раздел недоступен</p>
          <p className="text-text-muted mt-2 text-sm leading-relaxed">
            Кабинет владельца показывает выручку клиники. Доступ к нему выдаётся отдельно —
            обратитесь к владельцу или администратору.
          </p>
        </div>
      </div>
    );
  }

  const [report, weekly] = await Promise.all([getOwnerReport(), getWeeklyDynamics()]);

  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Кабинет владельца</h1>
        <p className="text-text-muted mt-1 text-xs">Полный отчёт из базы и глубокий ИИ-анализ по клинике</p>
      </header>

      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <Tile label="Выручка" value={formatMoney(report.revenue)} />
          <Tile label="Средний чек" value={formatMoney(report.avgCheck)} />
          <Tile label="Приёмов" value={report.appts} hint={`пришли ${report.arrived}`} />
          <Tile label="Первичных" value={report.firstVisits} />
          <Tile label="Неявки" value={`${report.noShowRatePct}%`} />
          <Tile label="Загрузка" value={`${report.avgLoadPct}%`} hint="3 кабинета" />
          <Tile label="Пациентов" value={report.patients.total} hint={`без согласия ${report.patients.noConsent}`} />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="border-border bg-surface rounded-xl border p-5">
            <h2 className="mb-4 text-sm font-medium">Сотрудники: производительность и часы</h2>
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[440px] border-collapse text-sm">
                <thead>
                  <tr className="text-text-subtle text-left text-2xs">
                    <th className="py-2 pr-3 font-normal">Специалист</th>
                    <th className="py-2 pr-3 text-right font-normal">Приёмы</th>
                    <th className="py-2 pr-3 text-right font-normal">Часы</th>
                    <th className="py-2 text-right font-normal">Выручка</th>
                  </tr>
                </thead>
                <tbody>
                  {report.staff.map((p) => (
                    <tr key={p.name} className="border-border-soft border-t">
                      <td className="py-2.5 pr-3">
                        <div className="font-medium">{p.name}</div>
                        <div className="text-text-subtle text-2xs">
                          пришли {p.arrived}
                          {p.noShow > 0 ? ` · неявок ${p.noShow}` : ""}
                        </div>
                      </td>
                      <td className="num py-2.5 pr-3 text-right">{p.appts}</td>
                      <td className="num py-2.5 pr-3 text-right">{p.hours.toFixed(1)}</td>
                      <td className="num py-2.5 text-right">{formatMoney(p.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="border-border bg-surface rounded-xl border p-5">
            {/* Подпись периода обязательна: тот же показатель за месяц стоит в
                «Отчётах», и без подписи одинаковые заголовки с разными числами
                читаются как ошибка платформы. */}
            <h2 className="text-sm font-medium">Загрузка кабинетов</h2>
            <p className="text-text-subtle mb-4 text-2xs">сегодня · за период — в разделе «Отчёты»</p>
            <ul className="flex flex-col gap-3">
              {report.rooms.map((l) => (
                <li key={l.name} className="flex items-center gap-3">
                  <span className="w-40 flex-none truncate text-sm" title={l.name}>{l.name}</span>
                  <span className="bg-list-gap relative h-2 flex-1 overflow-hidden rounded-pill">
                    <span
                      className="bg-accent absolute inset-y-0 left-0 rounded-pill"
                      style={{ width: `${l.ratePct}%` }}
                    />
                  </span>
                  <span className="num text-text-muted w-10 flex-none text-right text-xs">{l.ratePct}%</span>
                </li>
              ))}
            </ul>
            <h3 className="text-text-subtle mt-5 mb-2 text-2xs">Гипотезы — что улучшить</h3>
            <ul className="flex flex-col gap-2">
              {report.hypotheses.map((t, i) => (
                <li key={i} className="text-text-muted flex gap-2 text-sm leading-snug">
                  <span aria-hidden className="text-accent-text flex-none">•</span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="mt-4">
          <WeeklyCharts data={weekly} />
        </div>

        <section className="border-border bg-surface mt-4 rounded-xl border p-5">
          <div className="mb-4 flex items-baseline justify-between gap-3 max-md:flex-col max-md:items-start max-md:gap-1">
            <h2 className="text-sm font-medium">Выручка по услугам</h2>
            <span className="text-text-subtle text-xs">
              воронка: диалогов {report.funnel.dialogs} · звонков {report.funnel.calls}
            </span>
          </div>
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[440px] border-collapse text-sm">
              <thead>
                <tr className="text-text-subtle text-left text-2xs">
                  <th className="py-2 pr-3 font-normal">Услуга</th>
                  <th className="py-2 pr-3 text-right font-normal">Приёмы</th>
                  <th className="py-2 text-right font-normal">Выручка</th>
                </tr>
              </thead>
              <tbody>
                {report.services.map((s) => (
                  <tr key={s.service} className="border-border-soft border-t">
                    <td className="py-2 pr-3">{s.service}</td>
                    <td className="num py-2 pr-3 text-right">{s.count}</td>
                    <td className="num py-2 text-right">{formatMoney(s.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="mt-4">
          <OwnerAssistant />
        </div>
      </div>
    </>
  );
}
