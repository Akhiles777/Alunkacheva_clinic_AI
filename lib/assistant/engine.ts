import { formatMoney } from "../format";
import type { Patient } from "@/app/_data/store";
import {
  clinicPatientStats,
  patientVisitStats,
  pluralDays,
} from "./analytics";

/**
 * Оффлайн-движок ответов ассистента: разбирает вопрос, считает ответ по данным
 * стора локально. Это заглушка под будущий LLM — контракт (вопрос → текст)
 * сохранится, а внутренности заменятся на реальную интеграцию. Персональные
 * данные при этом наружу не уходят (§5).
 */
export interface AssistantAnswer {
  text: string;
}

export const SUGGESTIONS = [
  "Сделай сводку по пациентам",
  "С каким интервалом ходит Гринберг?",
  "Кого пора вернуть на курс?",
  "Откуда приходят пациенты?",
];

function findPatientByName(query: string, patients: Patient[]): Patient | null {
  const q = query.toLowerCase();
  // Совпадение по фамилии/имени — берём самое длинное найденное имя.
  let best: Patient | null = null;
  for (const p of patients) {
    const tokens = p.name.toLowerCase().split(/[\s.,-]+/).filter((t) => t.length >= 3);
    if (tokens.some((t) => q.includes(t))) {
      if (!best || p.name.length > best.name.length) best = p;
    }
  }
  return best;
}

function has(q: string, ...words: string[]): boolean {
  return words.some((w) => q.includes(w));
}

function patientAnswer(p: Patient): string {
  const s = patientVisitStats(p);
  const lines: string[] = [`${p.name}:`];
  lines.push(`• визитов: ${s.arrivedCount} из ${s.visitCount} записей`);
  if (s.avgIntervalDays !== null) {
    lines.push(`• ходит в среднем раз в ${s.avgIntervalDays} ${pluralDays(s.avgIntervalDays)}`);
  } else {
    lines.push("• интервал не посчитать — меньше двух состоявшихся визитов");
  }
  if (s.lastVisitDaysAgo !== null) {
    lines.push(
      s.lastVisitDaysAgo === 0
        ? "• последний визит: сегодня"
        : `• последний визит: ${s.lastVisitDaysAgo} ${pluralDays(s.lastVisitDaysAgo)} назад`,
    );
  }
  if (s.totalSpent > 0) lines.push(`• всего оплачено: ${formatMoney(s.totalSpent)}`);
  const active = p.courses.filter((c) => c.status === "active");
  const stalled = p.courses.filter((c) => c.status === "stalled");
  if (active.length) lines.push(`• на курсе: ${active.map((c) => `${c.title} (${c.used}/${c.total})`).join(", ")}`);
  if (stalled.length) lines.push(`• выпал из курса: ${stalled.map((c) => c.title).join(", ")} — стоит вернуть`);
  return lines.join("\n");
}

function summaryAnswer(patients: Patient[]): string {
  const s = clinicPatientStats(patients);
  const parts = [
    `Всего пациентов: ${s.total}.`,
    `Первичных: ${s.primary}, на курсе: ${s.onCourse}, выпали из курса: ${s.stalled}, без согласия: ${s.noConsent}.`,
    `С визитами: ${s.withVisits} из ${s.total}.`,
  ];
  if (s.avgIntervalDays !== null) {
    parts.push(`Средний интервал между визитами: ${s.avgIntervalDays} ${pluralDays(s.avgIntervalDays)}.`);
  }
  if (s.bySource.length) {
    parts.push("Источники: " + s.bySource.map((x) => `${x.source} — ${x.count}`).join(", ") + ".");
  }
  return parts.join("\n");
}

function stalledAnswer(patients: Patient[]): string {
  const rows = patients.flatMap((p) =>
    p.courses
      .filter((c) => c.status === "stalled")
      .map((c) => `• ${p.name} — ${c.title} (${c.used}/${c.total}, последний визит ${c.lastVisit})`),
  );
  if (rows.length === 0) return "Никто не выпал из курса — все идут по графику.";
  return `Пора вернуть на курс (${rows.length}):\n${rows.join("\n")}`;
}

function sourceAnswer(patients: Patient[]): string {
  const s = clinicPatientStats(patients);
  if (s.bySource.length === 0) return "Пока нет данных по источникам.";
  return "Откуда приходят пациенты:\n" + s.bySource.map((x) => `• ${x.source}: ${x.count}`).join("\n");
}

/**
 * Главная точка: вопрос + снимок пациентов → текстовый ответ. Порядок разбора —
 * от конкретного (пациент/интервал) к общему (сводка), иначе подсказка.
 */
export function answerQuery(query: string, patients: Patient[]): AssistantAnswer {
  const q = query.trim().toLowerCase();
  if (!q) return { text: "Спросите про пациента, интервал визитов или попросите сводку." };

  const patient = findPatientByName(q, patients);

  if (has(q, "интервал", "как часто", "частот", "ходит", "посеща", "регуляр") && patient) {
    return { text: patientAnswer(patient) };
  }
  if (has(q, "выпал", "верну", "вернуть", "потеря", "заброс")) {
    return { text: stalledAnswer(patients) };
  }
  if (has(q, "источник", "откуда", "канал")) {
    return { text: sourceAnswer(patients) };
  }
  if (has(q, "сводк", "аналитик", "статист", "отчёт", "отчет", "общая", "обзор", "сколько пациент")) {
    return { text: summaryAnswer(patients) };
  }
  if (patient) {
    return { text: patientAnswer(patient) };
  }
  return {
    text:
      "Пока я считаю ответы локально по вашим данным. Могу: дать сводку по пациентам, " +
      "посчитать интервал визитов конкретного клиента, показать выпавших из курса и разрез по источникам. " +
      "Скоро подключим полноценный ИИ.",
  };
}
