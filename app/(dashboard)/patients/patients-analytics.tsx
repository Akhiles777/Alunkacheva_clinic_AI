"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMoney } from "@/lib/format";
import { allCourses, useDb } from "@/app/_data/store";
import { getPatientsOverview, type PatientsOverview } from "./actions";
import { clinicPatientStats, pluralDays } from "@/lib/assistant/analytics";

function StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="border-border bg-surface rounded-xl border px-4 py-3.5">
      <div className="text-text-subtle text-2xs">{label}</div>
      <div className="readout mt-1 text-xl">{value}</div>
      {hint ? <div className="text-text-subtle mt-0.5 text-2xs">{hint}</div> : null}
    </div>
  );
}

export function PatientsAnalytics() {
  const db = useDb();

  /**
   * Числа по базе — с сервера.
   *
   * Прежде они считались по стору, а стор наполняется списком пациентов, где
   * нет ни визитов, ни курсов. Отсюда «с визитами 1 из 1794» при полутора
   * тысячах пациентов с историей и «средний интервал 0 дней»: считать было не
   * по чему. Курсы по-прежнему из стора — они там есть.
   */
  const [server, setServer] = useState<PatientsOverview | null>(null);
  useEffect(() => {
    getPatientsOverview().then(setServer).catch(() => {});
  }, []);

  const local = useMemo(() => clinicPatientStats(db.patients), [db.patients]);
  const courses = useMemo(() => allCourses(db.patients), [db.patients]);

  const stats = {
    total: server?.total ?? local.total,
    primary: server?.primaryToday ?? local.primary,
    withVisits: server?.withVisits ?? local.withVisits,
    avgIntervalDays: server ? server.avgIntervalDays : local.avgIntervalDays,
    noConsent: server?.noConsent ?? local.noConsent,
    bySource: server?.bySource ?? local.bySource,
    onCourse: local.onCourse,
    stalled: local.stalled,
  };

  const moneyLeft = courses.reduce((sum, c) => sum + c.moneyLeft, 0);
  const toReturn = courses.filter((c) => c.stalled).length;
  const maxSource = Math.max(1, ...stats.bySource.map((s) => s.count));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatTile label="Всего пациентов" value={stats.total} />
        <StatTile label="Первичные" value={stats.primary} hint="первый контакт сегодня" />
        <StatTile label="На курсе" value={stats.onCourse} />
        <StatTile label="Выпали из курса" value={stats.stalled} hint="без будущей записи" />
        <StatTile label="Без согласия" value={stats.noConsent} hint="ПДн не подписаны" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="border-border bg-surface rounded-xl border p-5">
          <div className="mb-4 flex items-baseline justify-between gap-3 max-md:flex-col max-md:items-start max-md:gap-1">
            <h2 className="text-sm font-medium">Источники обращений</h2>
            <span className="text-text-subtle text-xs">откуда пришли пациенты</span>
          </div>
          {stats.bySource.length === 0 ? (
            <p className="text-text-subtle text-sm">Пока нет данных.</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {stats.bySource.map((s) => (
                <li key={s.source} className="flex items-center gap-3">
                  <span className="w-28 flex-none truncate text-sm">{s.source}</span>
                  <span className="bg-list-gap relative h-2 flex-1 overflow-hidden rounded-pill">
                    <span
                      className="bg-accent absolute inset-y-0 left-0 rounded-pill"
                      style={{ width: `${(s.count / maxSource) * 100}%` }}
                    />
                  </span>
                  <span className="num text-text-muted w-6 flex-none text-right text-xs">{s.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="border-border bg-surface rounded-xl border p-5">
          <div className="mb-4 flex items-baseline justify-between gap-3 max-md:flex-col max-md:items-start max-md:gap-1">
            <h2 className="text-sm font-medium">Удержание и курсы</h2>
            <span className="text-text-subtle text-xs">деньги и регулярность</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            <div>
              <div className="text-text-subtle text-2xs">Средний интервал визитов</div>
              <div className="readout mt-1 text-lg">
                {stats.avgIntervalDays !== null
                  ? `${stats.avgIntervalDays} ${pluralDays(stats.avgIntervalDays)}`
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-text-subtle text-2xs">С визитами</div>
              <div className="readout mt-1 text-lg">
                {stats.withVisits} / {stats.total}
              </div>
            </div>
            <div>
              {/*
                Это не будущая выручка: деньги за курс клиника получила в день
                продажи. Здесь — сколько из них ещё не отработано сеансами.
              */}
              <div className="text-text-subtle text-2xs">Оплачено вперёд, не отработано</div>
              <div className="readout mt-1 text-lg">{formatMoney(moneyLeft)}</div>
            </div>
            <div>
              <div className="text-text-subtle text-2xs">Пора вернуть</div>
              <div className={`readout mt-1 text-lg ${toReturn > 0 ? "text-accent-text" : ""}`}>{toReturn}</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
