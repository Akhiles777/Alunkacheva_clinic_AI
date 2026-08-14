import { describe, expect, it } from "vitest";
import { buildFunnel } from "./funnel";
import { averageCheck, withSourceShares, withStaffShares } from "./summary";

describe("buildFunnel", () => {
  const steps = buildFunnel({ inquiries: 1040, booked: 512, arrived: 392 });

  it("отдаёт три шага в порядке воронки", () => {
    expect(steps.map((step) => step.key)).toEqual(["inquiries", "booked", "arrived"]);
  });

  it("у первого шага нет предыдущего", () => {
    expect(steps[0].conversionFromPrev).toBeNull();
    expect(steps[0].lostFromPrev).toBeNull();
    expect(steps[0].shareOfTop).toBe(1);
  });

  it("считает конверсию и потерю между шагами", () => {
    expect(steps[1].conversionFromPrev).toBeCloseTo(512 / 1040);
    expect(steps[1].lostFromPrev).toBe(528);
    expect(steps[1].lossRateFromPrev).toBeCloseTo(1 - 512 / 1040);

    expect(steps[2].conversionFromPrev).toBeCloseTo(392 / 512);
    expect(steps[2].lostFromPrev).toBe(120);
  });

  it("доля от вершины считается от обращений, а не от предыдущего шага", () => {
    expect(steps[2].shareOfTop).toBeCloseTo(392 / 1040);
  });

  it("пустой период не делит на ноль", () => {
    const empty = buildFunnel({ inquiries: 0, booked: 0, arrived: 0 });
    expect(empty.every((step) => step.shareOfTop === 0)).toBe(true);
    expect(empty[1].conversionFromPrev).toBe(0);
  });

  it("не показывает отрицательную потерю, если пришло больше, чем записалось", () => {
    // Бывает: запись создана в прошлом периоде, а визит состоялся в этом.
    const steps = buildFunnel({ inquiries: 100, booked: 40, arrived: 45 });
    expect(steps[2].lostFromPrev).toBe(0);
    expect(steps[2].lossRateFromPrev).toBe(0);
    expect(steps[2].conversionFromPrev).toBeGreaterThan(1);
  });
});

describe("averageCheck", () => {
  it("делит выручку на пришедших", () => {
    expect(averageCheck(1886400, 392)).toBe(4812.24);
  });

  it("без визитов чек нулевой, а не NaN", () => {
    expect(averageCheck(1000, 0)).toBe(0);
  });
});

describe("withStaffShares", () => {
  const rows = [
    { staffId: "1", name: "Остеопат", specialty: "Остеопатия", appointments: 68, revenue: 476000 },
    { staffId: "2", name: "Врач IV-терапии", specialty: "IV-терапия", appointments: 94, revenue: 611000 },
    { staffId: "3", name: "Процедурная сестра", specialty: "Анализы", appointments: 112, revenue: 168400 },
  ];

  it("нормирует приёмы и выручку независимо друг от друга", () => {
    const result = withStaffShares(rows);
    const nurse = result.find((row) => row.staffId === "3")!;
    const ivDoctor = result.find((row) => row.staffId === "2")!;

    // Процедурная сестра первая по приёмам и последняя по выручке —
    // это нормально и усреднением не исправляется.
    expect(nurse.appointmentsShare).toBe(1);
    expect(nurse.revenueShare).toBeCloseTo(168400 / 611000);
    expect(ivDoctor.revenueShare).toBe(1);
    expect(ivDoctor.appointmentsShare).toBeCloseTo(94 / 112);
  });

  it("считает средний чек по строке", () => {
    const [osteopath] = withStaffShares(rows);
    expect(osteopath.avgCheck).toBe(7000);
  });

  it("пустая таблица не ломается", () => {
    expect(withStaffShares([])).toEqual([]);
  });
});

describe("withSourceShares", () => {
  it("сортирует по убыванию и нормирует по максимуму", () => {
    const result = withSourceShares([
      { code: "site", title: "Сайт", inquiries: 90, booked: 30 },
      { code: "instagram", title: "Instagram", inquiries: 420, booked: 180 },
      { code: "whatsapp", title: "WhatsApp", inquiries: 310, booked: 150 },
    ]);

    expect(result.map((row) => row.code)).toEqual(["instagram", "whatsapp", "site"]);
    expect(result[0].share).toBe(1);
    expect(result[1].share).toBeCloseTo(310 / 420);
  });
});

describe("шаги воронки считаются по одному множеству", () => {
  it("конверсия не бывает больше ста процентов", () => {
    // На боевых данных выходило «обратились 2, записались 51» — 2550%:
    // первый шаг считался по переписке, второй по всем записям клиники,
    // включая созданные по телефону и в самом YCLIENTS.
    const steps = buildFunnel({ inquiries: 2, booked: 1, arrived: 1 });
    for (const s of steps) {
      if (s.conversionFromPrev !== null) expect(s.conversionFromPrev).toBeLessThanOrEqual(1);
    }
  });

  it("нулевые обращения не ломают расчёт", () => {
    const steps = buildFunnel({ inquiries: 0, booked: 0, arrived: 0 });
    expect(steps.every((s) => Number.isFinite(s.shareOfTop))).toBe(true);
  });
});
