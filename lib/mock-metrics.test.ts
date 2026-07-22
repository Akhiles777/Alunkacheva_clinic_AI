import { describe, expect, it } from "vitest";
import { getDashboardMetrics, longestFreeWindow, PERIODS } from "./mock-metrics";

describe("мок дашборда", () => {
  it("сходится сам с собой во всех периодах", async () => {
    for (const { key } of PERIODS) {
      const metrics = await getDashboardMetrics(key);

      // Первичные + курсовые + возвраты = пришедшие.
      expect(metrics.visitMix.total, key).toBe(metrics.funnel.arrived);

      // Разрезы воронки по источникам складываются в итог.
      const inquiries = metrics.sources.reduce((sum, row) => sum + row.inquiries, 0);
      const booked = metrics.sources.reduce((sum, row) => sum + row.booked, 0);
      expect(inquiries, key).toBe(metrics.funnel.inquiries);
      expect(booked, key).toBe(metrics.funnel.booked);

      // Разрез по специалистам складывается в приёмы и выручку.
      const appointments = metrics.staff.reduce((sum, row) => sum + row.appointments, 0);
      const revenue = metrics.staff.reduce((sum, row) => sum + row.revenue, 0);
      expect(appointments, key).toBe(metrics.funnel.arrived);
      expect(revenue, key).toBe(metrics.money.revenue);

      // Воронка не расширяется книзу.
      expect(metrics.funnel.booked).toBeLessThanOrEqual(metrics.funnel.inquiries);
      expect(metrics.funnel.arrived).toBeLessThanOrEqual(metrics.funnel.booked);
    }
  });

  it("выручка по курсам меньше суммы проданных курсов — признание идёт по визитам", async () => {
    const metrics = await getDashboardMetrics("month");
    expect(metrics.money.courseRevenue).toBeLessThan(metrics.money.coursesAmount);
  });

  it("полоса дня непротиворечива: занятость, окна и проценты", async () => {
    const metrics = await getDashboardMetrics("month");
    expect(metrics.rooms).toHaveLength(3);

    for (const room of metrics.rooms) {
      expect(room.workingMinutes).toBe(room.closeMinute - room.openMinute);
      expect(room.busyMinutes).toBeGreaterThan(0);
      expect(room.busyMinutes).toBeLessThanOrEqual(room.workingMinutes);
      expect(room.occupancy).toBeCloseTo(room.busyMinutes / room.workingMinutes);

      // Приёмы не выходят за рабочий день и не наползают друг на друга.
      const sorted = [...room.intervals].sort((a, b) => a.startMinute - b.startMinute);
      for (const [index, interval] of sorted.entries()) {
        expect(interval.endMinute).toBeGreaterThan(interval.startMinute);
        expect(interval.startMinute).toBeGreaterThanOrEqual(room.openMinute);
        expect(interval.endMinute).toBeLessThanOrEqual(room.closeMinute);
        if (index > 0) {
          expect(interval.startMinute).toBeGreaterThanOrEqual(sorted[index - 1].endMinute);
        }
      }

      // Показываем только окна от часа.
      for (const gap of room.gaps) {
        expect(gap.durationMin).toBeGreaterThanOrEqual(60);
      }
      expect(longestFreeWindow(room)).toBeGreaterThanOrEqual(
        Math.max(0, ...room.gaps.map((gap) => gap.durationMin)),
      );
    }
  });

  it("в процедурном кабинете длинные капельницы соседствуют с короткими заборами", async () => {
    const metrics = await getDashboardMetrics("month");
    const procedureRoom = metrics.rooms.find((room) => room.roomId === "room-2")!;
    const durations = procedureRoom.intervals.map((i) => i.endMinute - i.startMinute);

    expect(Math.max(...durations)).toBeGreaterThanOrEqual(90);
    expect(Math.min(...durations)).toBeLessThanOrEqual(15);
  });
});
