import { describe, expect, it } from "vitest";
import type { Patient } from "@/app/_data/store";
import {
  avgIntervalDays,
  clinicPatientStats,
  parseRuDate,
  patientVisitStats,
  pluralDays,
  visitDates,
} from "./analytics";

const NOW = new Date(2026, 6, 30); // 30 июля 2026

function patient(over: Partial<Patient>): Patient {
  return {
    id: "p",
    name: "Тест",
    bornYear: null,
    firstSeen: "ранее",
    source: "Instagram",
    channel: "instagram",
    phones: [],
    notes: [],
    relations: [],
    courses: [],
    visits: [],
    messages: [],
    ...over,
  };
}
function visit(date: string, status: Patient["visits"][number]["status"] = "arrived", amount = 5000) {
  return { id: date, date, service: "S", doctor: "D", status, amount };
}

describe("parseRuDate", () => {
  it("разбирает «DD месяц» и «DD месяц YYYY»", () => {
    expect(parseRuDate("23 июля", NOW)?.getTime()).toBe(new Date(2026, 6, 23).getTime());
    expect(parseRuDate("12 марта 2026", NOW)?.getTime()).toBe(new Date(2026, 2, 12).getTime());
  });
  it("«сегодня» и «N дней назад»", () => {
    expect(parseRuDate("сегодня", NOW)?.getTime()).toBe(new Date(2026, 6, 30).getTime());
    expect(parseRuDate("18 дней назад", NOW)?.getTime()).toBe(new Date(2026, 6, 12).getTime());
  });
  it("мусор → null", () => {
    expect(parseRuDate("когда-то")).toBeNull();
  });
});

describe("visitDates / avgIntervalDays", () => {
  it("берёт только состоявшиеся визиты, сортирует", () => {
    const p = patient({ visits: [visit("23 июля"), visit("9 июля"), visit("2 июля", "no_show"), visit("16 июля")] });
    const dates = visitDates(p, NOW);
    expect(dates.map((d) => d.getDate())).toEqual([9, 16, 23]);
  });
  it("средний интервал = 7 дней", () => {
    const p = patient({ visits: [visit("2 июля"), visit("9 июля"), visit("16 июля"), visit("23 июля")] });
    expect(avgIntervalDays(visitDates(p, NOW))).toBe(7);
  });
  it("меньше двух визитов → null", () => {
    expect(avgIntervalDays(visitDates(patient({ visits: [visit("2 июля")] }), NOW))).toBeNull();
  });
});

describe("patientVisitStats", () => {
  it("считает суммы и последний визит", () => {
    const p = patient({ visits: [visit("2 июля", "arrived", 6500), visit("23 июля", "arrived", 6500)] });
    const s = patientVisitStats(p, NOW);
    expect(s.arrivedCount).toBe(2);
    expect(s.avgIntervalDays).toBe(21);
    expect(s.totalSpent).toBe(13000);
    expect(s.lastVisitDaysAgo).toBe(7);
  });
});

describe("clinicPatientStats", () => {
  it("агрегирует метки и источники", () => {
    const patients = [
      patient({ id: "1", source: "Instagram", firstSeen: "сегодня", visits: [visit("2 июля"), visit("16 июля")] }),
      patient({ id: "2", source: "Instagram", courses: [{ id: "c", title: "Курс", used: 4, total: 10, status: "stalled", lastVisit: "18 дней назад" }] }),
      patient({ id: "3", source: "WhatsApp", notes: [{ id: "n", kind: "NO_CONSENT", text: "", createdAt: "", resolved: false }] }),
    ];
    const s = clinicPatientStats(patients, NOW);
    expect(s.total).toBe(3);
    expect(s.primary).toBe(1);
    expect(s.stalled).toBe(1);
    expect(s.noConsent).toBe(1);
    expect(s.withVisits).toBe(1);
    expect(s.bySource[0]).toEqual({ source: "Instagram", count: 2 });
  });
});

describe("pluralDays", () => {
  it("склоняет", () => {
    expect(pluralDays(1)).toBe("день");
    expect(pluralDays(3)).toBe("дня");
    expect(pluralDays(7)).toBe("дней");
    expect(pluralDays(21)).toBe("день");
  });
});
