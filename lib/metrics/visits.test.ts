import { describe, expect, it } from "vitest";
import { classifyPatientVisits, summarizeVisitMix, visitMixShares, type VisitInput } from "./visits";

const at = (iso: string) => new Date(iso);

describe("classifyPatientVisits", () => {
  it("первый ARRIVED-визит — первичный, остальные повторные", () => {
    const visits: VisitInput[] = [
      { appointmentId: "a", startAt: at("2026-01-10T09:00:00Z"), status: "ARRIVED" },
      { appointmentId: "b", startAt: at("2026-02-10T09:00:00Z"), status: "ARRIVED" },
    ];

    expect(classifyPatientVisits(visits).map((v) => v.kind)).toEqual(["FIRST", "RETURN"]);
  });

  it("сортирует историю сам", () => {
    const visits: VisitInput[] = [
      { appointmentId: "later", startAt: at("2026-02-10T09:00:00Z"), status: "ARRIVED" },
      { appointmentId: "earlier", startAt: at("2026-01-10T09:00:00Z"), status: "ARRIVED" },
    ];

    const result = classifyPatientVisits(visits);
    expect(result[0].appointmentId).toBe("earlier");
    expect(result[0].kind).toBe("FIRST");
  });

  it("не-ARRIVED визиты историю не двигают", () => {
    const visits: VisitInput[] = [
      { appointmentId: "no-show", startAt: at("2026-01-05T09:00:00Z"), status: "NO_SHOW" },
      { appointmentId: "planned", startAt: at("2026-01-06T09:00:00Z"), status: "CONFIRMED" },
      { appointmentId: "real", startAt: at("2026-01-10T09:00:00Z"), status: "ARRIVED" },
    ];

    expect(classifyPatientVisits(visits).map((v) => v.kind)).toEqual([null, null, "FIRST"]);
  });

  it("отменённый задним числом визит переводит следующий в первичные", () => {
    const before: VisitInput[] = [
      { appointmentId: "first", startAt: at("2026-01-10T09:00:00Z"), status: "ARRIVED" },
      { appointmentId: "second", startAt: at("2026-02-10T09:00:00Z"), status: "ARRIVED" },
    ];
    expect(classifyPatientVisits(before).map((v) => v.kind)).toEqual(["FIRST", "RETURN"]);

    // Администратор отменил первый визит задним числом.
    const after = before.map((visit) =>
      visit.appointmentId === "first" ? { ...visit, status: "CANCELLED" as const } : visit,
    );
    expect(classifyPatientVisits(after).map((v) => v.kind)).toEqual([null, "FIRST"]);
  });

  it("различает сеанс курса и возврат пациента", () => {
    const visits: VisitInput[] = [
      { appointmentId: "1", startAt: at("2026-01-10T09:00:00Z"), status: "ARRIVED" },
      { appointmentId: "2", startAt: at("2026-01-17T09:00:00Z"), status: "ARRIVED", courseId: "c1" },
      { appointmentId: "3", startAt: at("2026-01-24T09:00:00Z"), status: "ARRIVED", courseId: "c1" },
      // Курс закончился, пациент вернулся сам — это уже не сеанс программы.
      { appointmentId: "4", startAt: at("2026-06-01T09:00:00Z"), status: "ARRIVED" },
    ];

    expect(classifyPatientVisits(visits).map((v) => v.kind)).toEqual([
      "FIRST",
      "COURSE_SESSION",
      "COURSE_SESSION",
      "RETURN",
    ]);
  });

  it("первый визит остаётся первичным, даже если он сеанс курса", () => {
    const visits: VisitInput[] = [
      { appointmentId: "1", startAt: at("2026-01-10T09:00:00Z"), status: "ARRIVED", courseId: "c1" },
      { appointmentId: "2", startAt: at("2026-01-17T09:00:00Z"), status: "ARRIVED", courseId: "c1" },
    ];

    expect(classifyPatientVisits(visits).map((v) => v.kind)).toEqual(["FIRST", "COURSE_SESSION"]);
  });

  it("пустая история не ломается", () => {
    expect(classifyPatientVisits([])).toEqual([]);
  });
});

describe("summarizeVisitMix", () => {
  it("считает только состоявшиеся визиты", () => {
    const mix = summarizeVisitMix(["FIRST", "COURSE_SESSION", "COURSE_SESSION", "RETURN", null]);
    expect(mix).toEqual({ first: 1, courseSession: 2, returned: 1, total: 4 });
  });

  it("доли сходятся в единицу", () => {
    const shares = visitMixShares({ first: 1, courseSession: 2, returned: 1, total: 4 });
    expect(shares.first + shares.courseSession + shares.returned).toBeCloseTo(1);
    expect(shares.courseSession).toBe(0.5);
  });

  it("пустой период не делит на ноль", () => {
    expect(visitMixShares({ first: 0, courseSession: 0, returned: 0, total: 0 })).toEqual({
      first: 0,
      courseSession: 0,
      returned: 0,
    });
  });
});
