import { describe, expect, it } from "vitest";
import { clinicDateKey, clinicDayRange, startOfClinicDay } from "./clinic-time";

/**
 * Сервер обычно живёт по UTC, клиника — по московскому времени. Раньше границу
 * суток брали `setHours(0,0,0,0)`, то есть по часам сервера: три часа каждой
 * ночи «сегодня» на экране означало вчера.
 */
describe("сутки клиники", () => {
  it("час ночи по клинике — сутки уже сегодняшние", () => {
    // 22:30 UTC = 01:30 в Москве следующего дня.
    const at = new Date("2026-08-17T22:30:00Z");
    expect(clinicDateKey(at, "Europe/Moscow")).toBe("2026-08-18");
    expect(startOfClinicDay(at, "Europe/Moscow").toISOString()).toBe("2026-08-17T21:00:00.000Z");
  });

  it("день по клинике совпадает с днём по UTC, когда время не пограничное", () => {
    const at = new Date("2026-08-17T12:00:00Z");
    expect(clinicDateKey(at, "Europe/Moscow")).toBe("2026-08-17");
    expect(startOfClinicDay(at, "Europe/Moscow").toISOString()).toBe("2026-08-16T21:00:00.000Z");
  });

  it("сутки длятся ровно сутки", () => {
    const { start, end } = clinicDayRange(new Date("2026-08-17T12:00:00Z"), "Europe/Moscow");
    expect(end.getTime() - start.getTime()).toBe(24 * 3600_000);
  });

  it("пояс с переходом на летнее время не ломает границу", () => {
    // Берлин переходит на зимнее время 25 октября 2026 года.
    const at = new Date("2026-10-25T10:00:00Z");
    expect(clinicDateKey(at, "Europe/Berlin")).toBe("2026-10-25");
    const { start, end } = clinicDayRange(at, "Europe/Berlin");
    expect(start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    // В день перехода суток на час больше — и это правильный ответ, а не сбой.
    expect(end.getTime() - start.getTime()).toBe(25 * 3600_000);
  });
});
