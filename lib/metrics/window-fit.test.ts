import { describe, expect, it } from "vitest";
import {
  fitsWindow,
  minutesUntil,
  windowIsPast,
  TIGHT_MINUTES,
  type CandidateInput,
  type WindowSlot,
} from "./window-fit";

const slot: WindowSlot = {
  startMinute: 14 * 60,
  durationMin: 60,
  roomId: "room-1",
  date: new Date("2026-09-11T00:00:00+03:00"),
};

const candidate = (p: Partial<CandidateInput> = {}): CandidateInput => ({
  patientId: "p1",
  patientName: "Пациент",
  basis: "выпал из курса",
  serviceId: "s1",
  serviceTitle: "БОС-терапия",
  serviceDurationMin: 60,
  serviceRoomIds: [],
  staffAvailable: true,
  reachable: true,
  busyAtWindow: false,
  money: 2800,
  ...p,
});

describe("кого можно поставить в окно", () => {
  it("подходящий кандидат проходит", () => {
    expect(fitsWindow(candidate(), slot)).toEqual({ ok: true });
  });

  it("услуга длиннее окна — не показываем", () => {
    expect(fitsWindow(candidate({ serviceDurationMin: 90 }), slot).reason).toBe("long");
  });

  it("услуга ровно в окно — показываем", () => {
    expect(fitsWindow(candidate({ serviceDurationMin: 60 }), slot).ok).toBe(true);
  });

  it("услуга не проводится в этом кабинете", () => {
    expect(fitsWindow(candidate({ serviceRoomIds: ["room-2"] }), slot).reason).toBe("room");
  });

  it("кабинет не ограничен — подходит любой", () => {
    expect(fitsWindow(candidate({ serviceRoomIds: [] }), slot).ok).toBe(true);
  });

  it("специалист занят или не работает", () => {
    expect(fitsWindow(candidate({ staffAvailable: false }), slot).reason).toBe("staff");
  });

  it("нет канала связи — писать некуда", () => {
    expect(fitsWindow(candidate({ reachable: false }), slot).reason).toBe("unreachable");
  });

  it("у пациента своя запись в это время", () => {
    expect(fitsWindow(candidate({ busyAtWindow: true }), slot).reason).toBe("busy");
  });

  it("неизвестна услуга — предлагать нечего", () => {
    expect(fitsWindow(candidate({ serviceId: null }), slot).reason).toBe("unknownService");
    expect(fitsWindow(candidate({ serviceDurationMin: null }), slot).reason).toBe("unknownService");
  });
});

describe("время окна", () => {
  it("окно в прошлом кандидатов не имеет", () => {
    const now = new Date("2026-09-11T15:00:00+03:00");
    expect(windowIsPast(slot, now)).toBe(true);
    expect(windowIsPast(slot, new Date("2026-09-11T09:00:00+03:00"))).toBe(false);
  });

  it("сколько осталось — по нему решаем, успеют ли договориться", () => {
    const now = new Date("2026-09-11T13:30:00+03:00");
    expect(minutesUntil(slot, now)).toBe(30);
    expect(minutesUntil(slot, now) < TIGHT_MINUTES).toBe(true);
  });
});
