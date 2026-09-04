import { describe, expect, it } from "vitest";
import { attendanceAudit, MARK_GRACE_HOURS, type VisitOutcome } from "./attendance";

const NOW = new Date("2026-09-04T12:00:00+03:00");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600 * 1000);
const daysAgo = (d: number) => hoursAgo(d * 24);

const visit = (over: Partial<VisitOutcome> = {}): VisitOutcome => ({
  startAt: daysAgo(3),
  status: "ARRIVED",
  revenue: 5000,
  ...over,
});

describe("разобранность визитов", () => {
  it("считает исходы по статусам", () => {
    const a = attendanceAudit(
      [
        visit({ status: "ARRIVED" }),
        visit({ status: "NO_SHOW" }),
        visit({ status: "CANCELLED" }),
      ],
      NOW,
    );
    expect(a.arrived).toBe(1);
    expect(a.noShow).toBe(1);
    expect(a.cancelled).toBe(1);
    expect(a.noShowRate).toBe(0.5);
  });

  /**
   * Главное, ради чего написано: «Неявки 0%» означает либо «неявок не было»,
   * либо «никто ничего не отмечает». Второе должно быть видно числом.
   */
  it("прошедший приём без отметки — неразобранный, а не состоявшийся", () => {
    const a = attendanceAudit([visit({ status: "CONFIRMED", startAt: daysAgo(10) })], NOW);
    expect(a.unmarked).toBe(1);
    expect(a.arrived).toBe(0);
    expect(a.noShowRate).toBeNull();
    expect(a.coverage).toBe(0);
  });

  it("деньги неразобранных считаются отдельно: их нет ни в одном разрезе", () => {
    const a = attendanceAudit(
      [
        visit({ status: "CONFIRMED", startAt: daysAgo(10), revenue: 8000 }),
        visit({ status: "CREATED", startAt: daysAgo(20), revenue: 2000 }),
      ],
      NOW,
    );
    expect(a.unmarkedMoney).toBe(10000);
    expect(a.oldestUnmarkedAt).toEqual(daysAgo(20));
  });

  /**
   * Приём, начавшийся час назад, ещё идёт. Требовать у него отметку — значит
   * назвать неразобранным весь сегодняшний день каждое утро.
   */
  it("сегодняшний приём неразобранным не считается", () => {
    const a = attendanceAudit([visit({ status: "CONFIRMED", startAt: hoursAgo(2) })], NOW);
    expect(a.unmarked).toBe(0);
    expect(a.upcoming).toBe(1);
  });

  it("граница отсрочки: сутки прошли — уже неразобранный, часом раньше — ещё нет", () => {
    const past = attendanceAudit(
      [visit({ status: "CONFIRMED", startAt: hoursAgo(MARK_GRACE_HOURS) })],
      NOW,
    );
    expect(past.unmarked).toBe(1);
    const early = attendanceAudit(
      [visit({ status: "CONFIRMED", startAt: hoursAgo(MARK_GRACE_HOURS - 1) })],
      NOW,
    );
    expect(early.unmarked).toBe(0);
  });

  it("будущая запись исходом не считается и долю не разбавляет", () => {
    const a = attendanceAudit(
      [
        visit({ status: "ARRIVED" }),
        visit({ status: "CONFIRMED", startAt: new Date(NOW.getTime() + 86_400_000) }),
      ],
      NOW,
    );
    expect(a.upcoming).toBe(1);
    expect(a.noShowRate).toBe(0);
  });

  it("отменённые в разобранность не входят: их исход известен и он не приём", () => {
    const a = attendanceAudit([visit({ status: "CANCELLED", startAt: daysAgo(30) })], NOW);
    expect(a.unmarked).toBe(0);
    expect(a.coverage).toBeNull();
  });

  it("пустой период — прочерки, а не нули", () => {
    const a = attendanceAudit([], NOW);
    expect(a.noShowRate).toBeNull();
    expect(a.coverage).toBeNull();
    expect(a.oldestUnmarkedAt).toBeNull();
  });

  it("разобранность: половина отмечена — половина покрытия", () => {
    const a = attendanceAudit(
      [
        visit({ status: "ARRIVED" }),
        visit({ status: "CONFIRMED", startAt: daysAgo(10) }),
      ],
      NOW,
    );
    expect(a.coverage).toBe(0.5);
  });
});
