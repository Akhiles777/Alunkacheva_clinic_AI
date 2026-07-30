"use client";

import { formatMoney } from "@/lib/format";
import { patientTags, useDb } from "@/app/_data/store";
import { patientVisitStats, pluralDays } from "@/lib/assistant/analytics";

/**
 * Правая колонка личной страницы пациента: аналитика и инсайты, посчитанные
 * локально из стора. Заполняет пространство, которое раньше пустовало.
 */
function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border bg-surface rounded-xl border px-4 py-3">
      <div className="text-text-subtle text-2xs">{label}</div>
      <div className="readout mt-1 text-lg">{value}</div>
    </div>
  );
}

export function PatientAnalyticsPanel({ patientId }: { patientId: string }) {
  const db = useDb();
  const patient = db.patients.find((p) => p.id === patientId);
  if (!patient) return null;

  const s = patientVisitStats(patient);
  const tags = patientTags(patient);
  const activeCourse = patient.courses.find((c) => c.status === "active");
  const stalled = patient.courses.filter((c) => c.status === "stalled");

  const insights: string[] = [];
  if (s.avgIntervalDays !== null) {
    insights.push(`Ходит в среднем раз в ${s.avgIntervalDays} ${pluralDays(s.avgIntervalDays)}.`);
  }
  if (s.lastVisitDaysAgo !== null) {
    insights.push(
      s.lastVisitDaysAgo === 0
        ? "Последний визит — сегодня."
        : `Последний визит был ${s.lastVisitDaysAgo} ${pluralDays(s.lastVisitDaysAgo)} назад.`,
    );
  }
  if (activeCourse) {
    insights.push(`Идёт курс «${activeCourse.title}»: ${activeCourse.used} из ${activeCourse.total}.`);
  }
  if (stalled.length) {
    insights.push(`Выпал из курса: ${stalled.map((c) => c.title).join(", ")} — стоит вернуть.`);
  }
  if (patient.notes.some((n) => n.kind === "NO_CONSENT" && !n.resolved)) {
    insights.push("Не подписано согласие на обработку ПДн.");
  }
  insights.push(`Первое обращение: ${patient.source}, ${patient.firstSeen}.`);

  return (
    <div className="flex flex-col gap-4">
      <section className="border-border bg-surface rounded-xl border p-5">
        <h2 className="mb-4 text-sm font-medium">Аналитика</h2>
        <div className="grid grid-cols-2 gap-3">
          <Tile label="Визитов" value={`${s.arrivedCount} / ${s.visitCount}`} />
          <Tile
            label="Средний интервал"
            value={s.avgIntervalDays !== null ? `${s.avgIntervalDays} ${pluralDays(s.avgIntervalDays)}` : "—"}
          />
          <Tile
            label="Последний визит"
            value={
              s.lastVisitDaysAgo === null
                ? "—"
                : s.lastVisitDaysAgo === 0
                  ? "сегодня"
                  : `${s.lastVisitDaysAgo} ${pluralDays(s.lastVisitDaysAgo)} назад`
            }
          />
          <Tile label="Всего оплачено" value={formatMoney(s.totalSpent)} />
        </div>
        {tags.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span key={t} className="text-text-muted bg-chip rounded-sm px-2 py-0.5 text-2xs">
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      <section className="border-border bg-surface rounded-xl border p-5">
        <h2 className="mb-3 text-sm font-medium">Инсайты</h2>
        <ul className="flex flex-col gap-2">
          {insights.map((line, i) => (
            <li key={i} className="text-text-muted flex gap-2 text-sm leading-snug">
              <span aria-hidden className="text-accent-text flex-none">•</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
