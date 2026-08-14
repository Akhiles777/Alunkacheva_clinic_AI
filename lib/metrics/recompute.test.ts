import { describe, expect, it } from "vitest";
import { classifyPatientVisits, type VisitInput } from "./visits";

/**
 * Проверяем то, ради чего пересчёт и существует: правильную раскладку
 * истории пациента. Сам пересчёт ходит в базу и проверяется на стенде.
 */
const at = (d: string): Date => new Date(`${d}T10:00:00.000Z`);

describe("первичный и повторный после выгрузки", () => {
  it("первый состоявшийся визит — первичный, остальные повторные", () => {
    const visits: VisitInput[] = [
      { appointmentId: "a", startAt: at("2025-01-10"), status: "ARRIVED" },
      { appointmentId: "b", startAt: at("2025-03-05"), status: "ARRIVED" },
      { appointmentId: "c", startAt: at("2025-06-01"), status: "ARRIVED" },
    ];
    expect(classifyPatientVisits(visits).map((v) => v.kind)).toEqual(["FIRST", "RETURN", "RETURN"]);
  });

  it("несостоявшиеся визиты историю не двигают", () => {
    // Иначе отменённая запись сделала бы настоящий первый приём повторным.
    const visits: VisitInput[] = [
      { appointmentId: "a", startAt: at("2025-01-10"), status: "CANCELLED" },
      { appointmentId: "b", startAt: at("2025-02-10"), status: "NO_SHOW" },
      { appointmentId: "c", startAt: at("2025-03-10"), status: "ARRIVED" },
    ];
    const kinds = classifyPatientVisits(visits).map((v) => v.kind);
    expect(kinds).toEqual([null, null, "FIRST"]);
  });

  it("порядок в выгрузке не влияет: считаем по дате", () => {
    // Из YCLIENTS записи приходят помесячными окнами и вперемешку.
    const visits: VisitInput[] = [
      { appointmentId: "поздний", startAt: at("2025-06-01"), status: "ARRIVED" },
      { appointmentId: "ранний", startAt: at("2025-01-10"), status: "ARRIVED" },
    ];
    const byId = new Map(classifyPatientVisits(visits).map((v) => [v.appointmentId, v.kind]));
    expect(byId.get("ранний")).toBe("FIRST");
    expect(byId.get("поздний")).toBe("RETURN");
  });

  it("сеанс курса отделён от настоящего возврата", () => {
    const visits: VisitInput[] = [
      { appointmentId: "a", startAt: at("2025-01-10"), status: "ARRIVED" },
      { appointmentId: "b", startAt: at("2025-01-17"), status: "ARRIVED", courseId: "к1" },
    ];
    expect(classifyPatientVisits(visits).map((v) => v.kind)).toEqual(["FIRST", "COURSE_SESSION"]);
  });

  it("пациент без визитов не первичный и не повторный", () => {
    expect(classifyPatientVisits([])).toEqual([]);
  });
});
