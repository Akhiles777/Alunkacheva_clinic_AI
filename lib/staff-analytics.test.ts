import { describe, expect, it } from "vitest";
import type { Appt } from "@/app/_data/store";
import { hypotheses, staffPerformance } from "./staff-analytics";

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

describe("staffPerformance", () => {
  it("считает приёмы, неявки, часы и выручку по сотруднику", () => {
    const appts = [
      // Цена приходит с визитом из YCLIENTS: зашитого прайса по ключевым
      // словам больше нет — он показывал свои числа и расходился с отчётами.
      appt({ id: "1", doctor: "Левин А.", status: "arrived", durationMin: 60, price: 8000 }),
      appt({ id: "2", doctor: "Левин А.", status: "no_show", durationMin: 45, price: 8000 }),
      appt({ id: "3", doctor: "Соколова Е.", service: "IV-терапия, капельница", status: "arrived", durationMin: 90, price: 6500 }),
      appt({ id: "4", doctor: "Левин А.", status: "planned", durationMin: 60, price: 8000 }),
    ];
    const perf = staffPerformance(appts);
    const levin = perf.find((p) => p.name === "Левин А.")!;
    /**
     * «Приём» — состоявшийся приём, и только он. Прежде здесь считались
     * пришедшие вместе с неявками, в карточке специалиста — иначе, в отчётах —
     * третьим способом: одно слово, три числа у одного человека.
     */
    expect(levin.appts).toBe(1);
    expect(levin.arrived).toBe(1);
    expect(levin.noShow).toBe(1);
    // Запланированное — ни приём, ни неявка: оно ещё не состоялось.
    expect(levin.planned).toBe(1);
    // Неявка в выручку не идёт: приём не состоялся.
    expect(levin.revenue).toBe(8000);
    // Часы — по занятому времени: состоявшийся приём и запланированный
    // кабинет занимают, неявка освобождает его для новой записи.
    expect(levin.bookedMinutes).toBe(120);
  });
});

describe("hypotheses", () => {
  it("говорит о кабинетах теми же числами, что ему дали", () => {
    // Загрузку не считает сам: иначе гипотезы расходились бы с таблицей рядом.
    const out = hypotheses([], [{ name: "Кабинет 3 — БОС-терапия", rate: 0.08 }]);
    expect(out.some((h) => h.includes("Кабинет 3 — БОС-терапия") && h.includes("8%"))).toBe(true);
  });

  it("подсказывает про неявки", () => {
    const appts = [appt({ doctor: "Мороз Д.", status: "no_show" })];
    expect(hypotheses(appts, []).some((h) => h.includes("Мороз Д.") && h.includes("неяв"))).toBe(true);
  });
});
