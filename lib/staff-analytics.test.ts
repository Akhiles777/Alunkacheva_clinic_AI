import { describe, expect, it } from "vitest";
import type { Appt } from "@/app/_data/store";
import { hypotheses, priceOf, roomLoad, staffPerformance } from "./staff-analytics";

function appt(over: Partial<Appt>): Appt {
  return {
    id: "a",
    roomId: "room-3",
    roomName: "Кабинет 3",
    doctor: "Левин А.",
    service: "Остеопатия, приём",
    patientId: null,
    patientName: "Тест",
    startMinute: 9 * 60,
    durationMin: 60,
    status: "arrived",
    isFirstVisit: false,
    ...over,
  };
}

describe("priceOf", () => {
  it("узнаёт услугу по названию", () => {
    expect(priceOf("IV-терапия, капельница")).toBe(6500);
    expect(priceOf("Забор анализов")).toBe(1200);
    expect(priceOf("Нечто новое")).toBe(5000);
  });
});

describe("staffPerformance", () => {
  it("считает приёмы, неявки, часы и выручку по сотруднику", () => {
    const appts = [
      appt({ id: "1", doctor: "Левин А.", status: "arrived", durationMin: 60 }),
      appt({ id: "2", doctor: "Левин А.", status: "no_show", durationMin: 45 }),
      appt({ id: "3", doctor: "Соколова Е.", service: "IV-терапия, капельница", status: "arrived", durationMin: 90 }),
    ];
    const perf = staffPerformance(appts);
    const levin = perf.find((p) => p.name === "Левин А.")!;
    expect(levin.appts).toBe(2);
    expect(levin.arrived).toBe(1);
    expect(levin.noShow).toBe(1);
    expect(levin.revenue).toBe(6500);
    // no_show не занимает кабинет → не идёт в bookedMinutes
    expect(levin.bookedMinutes).toBe(60);
  });
});

describe("roomLoad", () => {
  it("загрузка в пределах 0..1", () => {
    const appts = [appt({ roomId: "room-1", startMinute: 540, durationMin: 60 })];
    const loads = roomLoad(appts);
    const r1 = loads.find((l) => l.roomId === "room-1")!;
    expect(r1.rate).toBeGreaterThan(0);
    expect(r1.rate).toBeLessThanOrEqual(1);
    expect(r1.workingMinutes).toBe(12 * 60);
  });
});

describe("hypotheses", () => {
  it("подсказывает про неявки", () => {
    const appts = [appt({ doctor: "Мороз Д.", status: "no_show" })];
    expect(hypotheses(appts).some((h) => h.includes("Мороз Д.") && h.includes("неяв"))).toBe(true);
  });
});
