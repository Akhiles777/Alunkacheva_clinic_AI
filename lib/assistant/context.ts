import type { DB } from "@/app/_data/store";
import { clinicPatientStats, patientVisitStats, pluralDays } from "./analytics";

/**
 * Компактный снимок базы для ассистента — ТОЛЬКО ЧТЕНИЕ и анализ. Собираем
 * аналитическую выжимку (не сырые карточки): имена, метрики визитов, курсы,
 * источники, сводка по диалогам/звонкам/расписанию. Диагнозов и медданных в базе
 * нет; в промпт уходит агрегат, пригодный для анализа.
 */
const DIALOG_STATUS: Record<string, string> = {
  bot: "бот",
  escalated: "эскалация",
  human: "человек",
  closed: "закрыт",
};
const APPT_STATUS: Record<string, string> = {
  planned: "запланирован",
  confirmed: "подтверждён",
  arrived: "пришёл",
  no_show: "не пришёл",
};

export function buildAssistantContext(db: DB, patientLimit = 60): string {
  const s = clinicPatientStats(db.patients);
  const lines: string[] = [];

  lines.push("# Сводка клиники");
  lines.push(
    `Пациентов: ${s.total}; первичных: ${s.primary}; на курсе: ${s.onCourse}; ` +
      `выпали из курса: ${s.stalled}; без согласия: ${s.noConsent}; с визитами: ${s.withVisits}.`,
  );
  if (s.avgIntervalDays !== null) {
    lines.push(`Средний интервал визитов по клинике: ${s.avgIntervalDays} ${pluralDays(s.avgIntervalDays)}.`);
  }
  if (s.bySource.length) {
    lines.push("Источники: " + s.bySource.map((x) => `${x.source} — ${x.count}`).join(", ") + ".");
  }

  lines.push("");
  lines.push("# Пациенты");
  for (const p of db.patients.slice(0, patientLimit)) {
    const vs = patientVisitStats(p);
    const parts = [`- ${p.name} (источник: ${p.source})`];
    parts.push(`визитов ${vs.arrivedCount}/${vs.visitCount}`);
    if (vs.avgIntervalDays !== null) parts.push(`интервал ~${vs.avgIntervalDays} дн`);
    if (vs.lastVisitDaysAgo !== null) parts.push(`последний ${vs.lastVisitDaysAgo} дн назад`);
    if (vs.totalSpent > 0) parts.push(`оплачено ${vs.totalSpent} ₽`);
    if (p.courses.length) {
      parts.push(
        "курсы: " + p.courses.map((c) => `${c.title} ${c.used}/${c.total} (${c.status})`).join("; "),
      );
    }
    const activeNotes = p.notes.filter((n) => !n.resolved);
    if (activeNotes.length) parts.push("отметки: " + activeNotes.map((n) => n.text).join("; "));
    lines.push(parts.join("; "));
  }
  if (db.patients.length > patientLimit) {
    lines.push(`…и ещё ${db.patients.length - patientLimit} пациентов.`);
  }

  // Диалоги
  const dialogCounts = new Map<string, number>();
  for (const d of db.dialogs) dialogCounts.set(d.status, (dialogCounts.get(d.status) ?? 0) + 1);
  if (db.dialogs.length) {
    lines.push("");
    lines.push("# Диалоги");
    lines.push(
      "Всего " +
        db.dialogs.length +
        ": " +
        [...dialogCounts.entries()].map(([k, v]) => `${DIALOG_STATUS[k] ?? k} — ${v}`).join(", ") +
        ".",
    );
  }

  // Расписание на сегодня
  if (db.appointments.length) {
    const apptCounts = new Map<string, number>();
    for (const a of db.appointments) apptCounts.set(a.status, (apptCounts.get(a.status) ?? 0) + 1);
    lines.push("");
    lines.push("# Расписание сегодня");
    lines.push(
      "Записей " +
        db.appointments.length +
        ": " +
        [...apptCounts.entries()].map(([k, v]) => `${APPT_STATUS[k] ?? k} — ${v}`).join(", ") +
        ".",
    );
  }

  if (db.calls.length) {
    lines.push("");
    lines.push(`# Звонки\nЗанесено звонков: ${db.calls.length}.`);
  }

  return lines.join("\n");
}
