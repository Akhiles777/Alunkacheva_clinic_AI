import type { Appt } from "@/app/_data/store";
import { describe, expect, it } from "vitest";
import {
  buildCabinets,
  hasConflict,
  buildFreeWindows,
  durationLabel,
  nowMinuteInTz,
  roomIntervals,
} from "./schedule";

function appt(over: Partial<Appt>): Appt {
  return {
    id: "a",
    roomId: "room-1",
    roomName: "Кабинет 1",
    doctor: "Соколова Е.",
    service: "IV-терапия, капельница",
    patientId: null,
    patientName: "Тест",
    startMinute: 9 * 60,
    durationMin: 60,
    status: "confirmed",
    isFirstVisit: false,
    ...over,
  };
}

describe("hasConflict", () => {
  const appts = [appt({ id: "1", roomId: "room-1", startMinute: 540, durationMin: 60 })]; // 09:00–10:00

  it("пересечение внутри занятого слота → конфликт", () => {
    expect(hasConflict(appts, "room-1", 570, 30)).toBe(true); // 09:30–10:00
  });
  it("встык (10:00) — не конфликт", () => {
    expect(hasConflict(appts, "room-1", 600, 30)).toBe(false);
  });
  it("другой кабинет — не конфликт", () => {
    expect(hasConflict(appts, "room-2", 540, 60)).toBe(false);
  });
  it("исключение себя при переносе", () => {
    expect(hasConflict(appts, "room-1", 545, 30, "1")).toBe(false);
  });
  it("no_show освобождает слот", () => {
    const ns = [appt({ id: "2", roomId: "room-1", startMinute: 540, durationMin: 60, status: "no_show" })];
    expect(hasConflict(ns, "room-1", 570, 30)).toBe(false);
  });
});

describe("roomIntervals", () => {
  it("берёт только занимающие статусы", () => {
    const appts = [
      appt({ id: "1", startMinute: 540, durationMin: 60, status: "arrived" }),
      appt({ id: "2", startMinute: 600, durationMin: 60, status: "no_show" }),
    ];
    expect(roomIntervals(appts, "room-1")).toEqual([{ startMinute: 540, endMinute: 600 }]);
  });
});

describe("nowMinuteInTz", () => {
  it("московское время = UTC+3", () => {
    expect(nowMinuteInTz("Europe/Moscow", new Date("2026-07-30T08:30:00Z"))).toBe(11 * 60 + 30);
  });
});

describe("durationLabel", () => {
  it("форматирует часы и минуты", () => {
    expect(durationLabel(90)).toBe("1 ч 30 мин");
    expect(durationLabel(60)).toBe("1 ч");
    expect(durationLabel(45)).toBe("45 мин");
  });
});

describe("buildCabinets", () => {
  it("показывает текущий приём и следующее окно", () => {
    const appts = [appt({ id: "1", roomId: "room-1", startMinute: 540, durationMin: 60, status: "arrived" })];
    const cabs = buildCabinets(appts, 570); // сейчас 09:30
    const room1 = cabs.find((c) => c.id === "room-1")!;
    expect(room1.current?.until).toBe("10:00");
    expect(room1.nextFree?.time).toBe("10:00");
    // пустые кабинеты свободны сейчас
    const room2 = cabs.find((c) => c.id === "room-2")!;
    expect(room2.current).toBeNull();
  });
});

describe("buildFreeWindows", () => {
  it("возвращает окна по времени, первое — soon", () => {
    const appts = [appt({ id: "1", roomId: "room-1", startMinute: 540, durationMin: 60 })];
    const windows = buildFreeWindows(appts, 9 * 60); // с начала дня
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0].soon).toBe(true);
    // отсортированы по startMinute
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].startMinute).toBeGreaterThanOrEqual(windows[i - 1].startMinute);
    }
  });
});

describe("визит без кабинета", () => {
  it("не занимает ни один кабинет", () => {
    // Из YCLIENTS кабинеты не приходят вовсе: у клиники они не заведены как
    // ресурсы. Раньше такие визиты подставлялись в первый кабинет, и на
    // главной он выглядел занятым до конца дня.
    const appts: Appt[] = [
      {
        id: "a1",
        roomId: null,
        roomName: "",
        doctor: "Соколов",
        service: "Приём",
        patientId: "p1",
        patientName: "Пациент",
        startMinute: 600,
        durationMin: 60,
        status: "planned",
        price: 5000,
        isFirstVisit: false,
      } as Appt,
    ];
    const cabs = buildCabinets(appts, 570);
    expect(cabs.every((c) => c.current === null)).toBe(true);
    expect(cabs.every((c) => c.nextFree !== null)).toBe(true);
  });

  it("не создаёт конфликта при переносе", () => {
    expect(hasConflict([], null, 600, 60)).toBe(false);
  });
});

/**
 * Кабинеты на экране «Сегодня» приходят из базы клиники. Раньше список был
 * зашит в коде и совпадал с настоящим только по номеру: экран показывал
 * направления, которых у клиники нет.
 */
describe("buildCabinets с настоящими кабинетами", () => {
  const rooms = [
    { id: "room-1", name: "Кабинет 1 — процедурный", direction: "процедурный" },
    { id: "room-2", name: "Кабинет 2 — остеопатия", direction: "остеопатия" },
  ];

  it("показывает кабинеты клиники, а не зашитые", () => {
    const out = buildCabinets([], 10 * 60, { startMinute: 8 * 60, endMinute: 16 * 60 }, rooms);
    expect(out.map((c) => c.name)).toEqual([
      "Кабинет 1 — процедурный",
      "Кабинет 2 — остеопатия",
    ]);
  });

  it("кабинетов нет — и карточек нет", () => {
    // Пустой список означает, что кабинеты не заведены; выдумывать их нельзя.
    expect(buildCabinets([], 10 * 60, undefined, [])).toEqual([]);
  });
});
