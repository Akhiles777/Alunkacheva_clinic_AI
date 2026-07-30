import { describe, expect, it } from "vitest";
import { loadByService } from "./service-load";

describe("loadByService", () => {
  const serviceRooms = {
    iv: ["room-1", "room-2"], // IV идёт в двух кабинетах
    osteo: ["room-3"],
    lab: ["room-1"],
  };
  // За период каждый кабинет доступен 600 минут.
  const roomMinutes = { "room-1": 600, "room-2": 600, "room-3": 600 };

  it("считает загрузку по услуге от суммарных минут её кабинетов", () => {
    const appts = [
      { serviceId: "iv", durationMin: 90 },
      { serviceId: "iv", durationMin: 90 },
      { serviceId: "osteo", durationMin: 300 },
    ];
    const load = loadByService(appts, serviceRooms, roomMinutes);
    const iv = load.find((l) => l.serviceId === "iv")!;
    const osteo = load.find((l) => l.serviceId === "osteo")!;

    // IV: 180 занятых / (600+600) доступных = 0.15
    expect(iv.busyMinutes).toBe(180);
    expect(iv.availableMinutes).toBe(1200);
    expect(iv.ratio).toBeCloseTo(0.15);

    // Остеопатия: 300 / 600 = 0.5
    expect(osteo.ratio).toBeCloseTo(0.5);
  });

  it("две капельницы параллельно — 50% на услугу с двумя кабинетами", () => {
    // 600 минут занятости при 1200 доступных = 0.5, хотя один кабинет был бы 100%.
    const appts = [{ serviceId: "iv", durationMin: 600 }];
    const [iv] = loadByService(appts, { iv: ["room-1", "room-2"] }, roomMinutes);
    expect(iv.ratio).toBeCloseTo(0.5);
  });

  it("срезает загрузку по 100%", () => {
    const appts = [{ serviceId: "lab", durationMin: 900 }]; // > 600
    const [lab] = loadByService(appts, { lab: ["room-1"] }, roomMinutes);
    expect(lab.busyMinutes).toBe(900);
    expect(lab.availableMinutes).toBe(600);
    expect(lab.ratio).toBe(1);
  });

  it("нет доступных минут — загрузка 0, не NaN", () => {
    const [x] = loadByService([{ serviceId: "x", durationMin: 100 }], { x: ["missing"] }, {});
    expect(x.ratio).toBe(0);
  });

  it("услуга без приёмов имеет нулевую занятость, но остаётся в списке", () => {
    const load = loadByService([], serviceRooms, roomMinutes);
    expect(load.map((l) => l.serviceId).sort()).toEqual(["iv", "lab", "osteo"]);
    expect(load.every((l) => l.busyMinutes === 0 && l.ratio === 0)).toBe(true);
  });

  it("сортирует по убыванию загрузки", () => {
    const appts = [
      { serviceId: "osteo", durationMin: 540 }, // 0.9
      { serviceId: "lab", durationMin: 120 }, // 0.2
      { serviceId: "iv", durationMin: 600 }, // 0.5
    ];
    const load = loadByService(appts, serviceRooms, roomMinutes);
    expect(load.map((l) => l.serviceId)).toEqual(["osteo", "iv", "lab"]);
  });
});
