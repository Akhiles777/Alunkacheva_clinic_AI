import { describe, expect, it } from "vitest";
import {
  busyMinutes,
  clipToWindow,
  formatMinute,
  freeGaps,
  longestGap,
  mergeIntervals,
  occupancyRate,
  workingMinutes,
  workingWindowForDay,
  type Interval,
} from "./occupancy";

const DAY: Interval = { startMinute: 9 * 60, endMinute: 21 * 60 };

describe("mergeIntervals", () => {
  it("склеивает пересечение", () => {
    expect(
      mergeIntervals([
        { startMinute: 600, endMinute: 690 },
        { startMinute: 660, endMinute: 720 },
      ]),
    ).toEqual([{ startMinute: 600, endMinute: 720 }]);
  });

  it("склеивает встык", () => {
    expect(
      mergeIntervals([
        { startMinute: 600, endMinute: 660 },
        { startMinute: 660, endMinute: 700 },
      ]),
    ).toEqual([{ startMinute: 600, endMinute: 700 }]);
  });

  it("поглощает вложенный интервал", () => {
    expect(
      mergeIntervals([
        { startMinute: 600, endMinute: 780 },
        { startMinute: 620, endMinute: 640 },
      ]),
    ).toEqual([{ startMinute: 600, endMinute: 780 }]);
  });

  it("выбрасывает пустые и отрицательные", () => {
    expect(
      mergeIntervals([
        { startMinute: 600, endMinute: 600 },
        { startMinute: 700, endMinute: 690 },
      ]),
    ).toEqual([]);
  });
});

describe("busyMinutes", () => {
  it("не удваивает наложения — иначе загрузка уходит за 100%", () => {
    // Капельница 90 минут и забор анализов, поставленный в тот же кабинет.
    const intervals = [
      { startMinute: 600, endMinute: 690 },
      { startMinute: 620, endMinute: 635 },
    ];
    expect(busyMinutes(intervals, DAY)).toBe(90);
  });

  it("обрезает выходящее за рабочее окно", () => {
    const intervals = [{ startMinute: 8 * 60, endMinute: 10 * 60 }];
    expect(busyMinutes(intervals, DAY)).toBe(60);
  });

  it("полностью внерабочий интервал не считается", () => {
    expect(busyMinutes([{ startMinute: 6 * 60, endMinute: 7 * 60 }], DAY)).toBe(0);
  });

  it("суммирует разрозненные интервалы", () => {
    expect(
      busyMinutes(
        [
          { startMinute: 540, endMinute: 600 },
          { startMinute: 780, endMinute: 870 },
        ],
        DAY,
      ),
    ).toBe(150);
  });
});

describe("clipToWindow", () => {
  it("режет по границам окна", () => {
    expect(clipToWindow([{ startMinute: 480, endMinute: 1320 }], DAY)).toEqual([DAY]);
  });
});

describe("freeGaps", () => {
  it("находит окно между приёмами", () => {
    const intervals = [
      { startMinute: 540, endMinute: 630 },
      { startMinute: 750, endMinute: 810 },
    ];
    expect(freeGaps(intervals, DAY)).toEqual([
      { startMinute: 630, endMinute: 750, durationMin: 120 },
      { startMinute: 810, endMinute: 1260, durationMin: 450 },
    ]);
  });

  it("промежутки короче порога не показывает", () => {
    // 45 минут между остеопатией и капельницей — не окно, туда ничего не влезет.
    const intervals = [
      { startMinute: 540, endMinute: 600 },
      { startMinute: 645, endMinute: 1260 },
    ];
    expect(freeGaps(intervals, DAY)).toEqual([]);
  });

  it("окно ровно в 60 минут считается окном", () => {
    const intervals = [
      { startMinute: 540, endMinute: 600 },
      { startMinute: 660, endMinute: 1260 },
    ];
    expect(freeGaps(intervals, DAY)).toHaveLength(1);
    expect(freeGaps(intervals, DAY)[0].durationMin).toBe(60);
  });

  it("пустой кабинет — одно окно на весь день", () => {
    expect(freeGaps([], DAY)).toEqual([
      { startMinute: 540, endMinute: 1260, durationMin: 720 },
    ]);
  });

  it("полностью занятый кабинет окон не даёт", () => {
    expect(freeGaps([DAY], DAY)).toEqual([]);
  });

  it("наложения не создают ложных окон", () => {
    const intervals = [
      { startMinute: 540, endMinute: 800 },
      { startMinute: 600, endMinute: 660 },
    ];
    expect(freeGaps(intervals, DAY)).toEqual([
      { startMinute: 800, endMinute: 1260, durationMin: 460 },
    ]);
  });
});

describe("longestGap", () => {
  it("возвращает самое длинное окно — влезет ли капельница на 90 минут", () => {
    const intervals = [
      { startMinute: 540, endMinute: 660 },
      { startMinute: 700, endMinute: 760 },
      { startMinute: 900, endMinute: 960 },
    ];
    expect(longestGap(intervals, DAY)).toBe(1260 - 960);
  });
});

describe("workingWindowForDay", () => {
  const schedule = { weekday: 1, startMinute: 540, endMinute: 1260 };

  it("берёт регулярное расписание", () => {
    expect(workingWindowForDay(schedule)).toEqual({ startMinute: 540, endMinute: 1260 });
  });

  it("выходной кабинета — null, и в знаменатель он не попадает", () => {
    expect(workingWindowForDay(null)).toBeNull();
  });

  it("санитарный день закрывает кабинет поверх расписания", () => {
    expect(workingWindowForDay(schedule, { isClosed: true })).toBeNull();
  });

  it("укороченный день перекрывает расписание", () => {
    expect(
      workingWindowForDay(schedule, { isClosed: false, startMinute: 600, endMinute: 900 }),
    ).toEqual({ startMinute: 600, endMinute: 900 });
  });

  it("исключение без часов оставляет обычное расписание", () => {
    expect(workingWindowForDay(schedule, { isClosed: false })).toEqual({
      startMinute: 540,
      endMinute: 1260,
    });
  });

  it("вывернутое расписание отбрасывается", () => {
    expect(workingWindowForDay({ weekday: 7, startMinute: 1260, endMinute: 540 })).toBeNull();
  });
});

describe("workingMinutes и occupancyRate", () => {
  it("закрытые дни в знаменатель не идут", () => {
    expect(workingMinutes([DAY, null, DAY])).toBe(1440);
  });

  it("загрузка = занятые / рабочие", () => {
    expect(occupancyRate(360, 720)).toBe(0.5);
  });

  it("нулевой знаменатель не даёт NaN", () => {
    expect(occupancyRate(0, 0)).toBe(0);
  });

  it("загрузка не превышает 100%", () => {
    expect(occupancyRate(900, 720)).toBe(1);
  });
});

describe("formatMinute", () => {
  it("переводит минуты в часы", () => {
    expect(formatMinute(540)).toBe("09:00");
    expect(formatMinute(1260)).toBe("21:00");
    expect(formatMinute(755)).toBe("12:35");
  });
});
