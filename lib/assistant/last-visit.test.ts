import { describe, expect, it } from "vitest";
import { patientVisitStats } from "./analytics";
import type { Patient } from "@/app/_data/store";

function patient(visits: { at: string; status: "arrived" | "planned" }[]): Patient {
  return {
    id: "p1",
    name: "Тест",
    bornYear: null,
    firstSeen: "ранее",
    source: null,
    channel: "phone",
    phones: [],
    notes: [],
    relations: [],
    courses: [],
    messages: [],
    visits: visits.map((v, i) => ({
      id: `v${i}`,
      date: "",
      at: v.at,
      service: "Приём",
      doctor: "Врач",
      status: v.status,
      amount: 1000,
    })),
  } as unknown as Patient;
}

/**
 * На карточке пациента стояло «Последний визит −1 дней назад». Считалось
 * «полночь сегодня минус момент визита»: приём сегодня днём давал минус
 * четырнадцать часов и округлялся в минус один день.
 */
describe("сколько дней назад был последний визит", () => {
  const now = new Date("2026-08-18T20:00:00+03:00");

  it("визит сегодня днём — ноль, а не минус один", () => {
    const p = patient([{ at: "2026-08-18T14:00:00+03:00", status: "arrived" }]);
    expect(patientVisitStats(p, now).lastVisitDaysAgo).toBe(0);
  });

  it("визит сегодня позже, чем сейчас, тоже ноль", () => {
    const p = patient([{ at: "2026-08-18T22:30:00+03:00", status: "arrived" }]);
    expect(patientVisitStats(p, now).lastVisitDaysAgo).toBe(0);
  });

  it("вчерашний визит — один день", () => {
    const p = patient([{ at: "2026-08-17T09:00:00+03:00", status: "arrived" }]);
    expect(patientVisitStats(p, now).lastVisitDaysAgo).toBe(1);
  });

  it("неделю назад — семь дней, а не шесть из-за часов", () => {
    // Раньше поздний визит недельной давности округлялся до шести.
    const p = patient([{ at: "2026-08-11T19:00:00+03:00", status: "arrived" }]);
    expect(patientVisitStats(p, now).lastVisitDaysAgo).toBe(7);
  });

  it("визитов не было — прочерк, а не ноль", () => {
    expect(patientVisitStats(patient([]), now).lastVisitDaysAgo).toBeNull();
  });

  it("запланированный визит последним не считается", () => {
    const p = patient([
      { at: "2026-08-10T09:00:00+03:00", status: "arrived" },
      { at: "2026-08-25T09:00:00+03:00", status: "planned" },
    ]);
    expect(patientVisitStats(p, now).lastVisitDaysAgo).toBe(8);
  });
});
