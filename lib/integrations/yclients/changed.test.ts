import { describe, expect, it } from "vitest";
import { recordChanged } from "./changed";
import type { ExistingRecord } from "./lookups";

const START = new Date("2026-08-17T09:00:00Z");

const existing: ExistingRecord = {
  yclientsRecordId: 501,
  staffId: "st-1",
  patientId: "p-1",
  roomId: "r-1",
  primaryServiceId: "sv-1",
  startAt: START,
  endAt: new Date(START.getTime() + 45 * 60_000),
  durationMin: 45,
  status: "CREATED",
  attendanceRaw: null,
  // Prisma отдаёт Decimal — объект, а не число: сравнение должно это переживать.
  revenue: { toString: () => "8000" },
  isPaid: false,
  createdAtYclients: new Date("2026-08-10T12:00:00Z"),
  syncState: "SYNCED",
  deletedAt: null,
};

const incoming = {
  staffId: "st-1",
  patientId: "p-1",
  roomId: "r-1",
  primaryServiceId: "sv-1",
  startAt: new Date(START),
  endAt: new Date(START.getTime() + 45 * 60_000),
  durationMin: 45,
  status: "CREATED",
  attendanceRaw: null,
  revenue: 8000,
  isPaid: false,
  createdAtYclients: new Date("2026-08-10T12:00:00Z"),
  syncState: "SYNCED",
};

describe("изменился ли визит", () => {
  it("ничего не менялось — переписывать нечего", () => {
    // Ровно этот случай повторяется сотни раз каждый круг: последний месяц
    // перечитывается всегда, а меняется в нём почти ничего.
    expect(recordChanged({ existing, incoming, createdAtKnown: true })).toBe(false);
  });

  it("администратор отметил «пришёл» — изменение", () => {
    expect(
      recordChanged({
        existing,
        incoming: { ...incoming, status: "ARRIVED", attendanceRaw: 1 },
        createdAtKnown: true,
      }),
    ).toBe(true);
  });

  it("визит перенесли — изменение", () => {
    const later = new Date(START.getTime() + 3600_000);
    expect(
      recordChanged({
        existing,
        incoming: { ...incoming, startAt: later, endAt: new Date(later.getTime() + 45 * 60_000) },
        createdAtKnown: true,
      }),
    ).toBe(true);
  });

  it("изменилась стоимость — изменение, даже когда типы разные", () => {
    expect(
      recordChanged({ existing, incoming: { ...incoming, revenue: 4900 }, createdAtKnown: true }),
    ).toBe(true);
  });

  it("появился кабинет — изменение", () => {
    expect(
      recordChanged({ existing, incoming: { ...incoming, roomId: "r-2" }, createdAtKnown: true }),
    ).toBe(true);
  });

  it("визит был удалён у нас, а YCLIENTS его показывает — возвращаем", () => {
    expect(
      recordChanged({
        existing: { ...existing, deletedAt: new Date() },
        incoming,
        createdAtKnown: true,
      }),
    ).toBe(true);
  });

  it("дату создания без данных провайдера не сравниваем", () => {
    // Там заглушка — дата визита; сравнение с ней давало бы «изменилось»
    // каждому визиту на каждом круге.
    expect(
      recordChanged({
        existing,
        incoming: { ...incoming, createdAtYclients: START },
        createdAtKnown: false,
      }),
    ).toBe(false);
  });
});
