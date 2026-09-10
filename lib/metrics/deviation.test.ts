import { describe, expect, it } from "vitest";
import { deviationOf, median, MIN_HISTORY, tooQuiet } from "./deviation";

/** Восемь ровных недель — минимальная история, с которой сравнение разрешено. */
const steady = (value: number, n = MIN_HISTORY) => Array.from({ length: n }, () => value);
/** Восемь недель с заметным разбросом вокруг того же значения. */
const noisy = [80, 120, 90, 130, 70, 140, 100, 110];

describe("порог значимости", () => {
  it("до восьми недель истории сравнивать не с чем — и это сказано, а не заменено", () => {
    const d = deviationOf([100, 200, 50], 400);
    expect(d.skipped).toBe("no-history");
    expect(d.notable).toBe(false);
  });

  it("одно и то же отклонение значимо у ровной клиники и не значимо у шумной", () => {
    // ±10 вокруг сотни: у ровной это событие, у гуляющей — обычная неделя.
    const calm = [100, 102, 98, 101, 99, 100, 101, 99];
    expect(deviationOf(calm, 140).notable).toBe(true);
    expect(deviationOf(noisy, 140).notable).toBe(false);
  });

  it("фиксированного процента нет: у шумной клиники +40% не новость", () => {
    const d = deviationOf(noisy, 140);
    expect(d.notable).toBe(false);
    expect(d.median).toBe(105);
  });

  it("один выброс в истории не назначает себя нормой", () => {
    // Семь недель по сотне и одна отпускная в ноль: медиана остаётся сотней.
    const withOutlier = [100, 100, 100, 0, 100, 100, 100, 100];
    expect(deviationOf(withOutlier, 100).median).toBe(100);
    expect(deviationOf(withOutlier, 100).notable).toBe(false);
  });

  it("нулевой разброс не делает сенсацией отличие на единицу", () => {
    // Восемь недель по две неявки, стало три — это не событие.
    expect(deviationOf(steady(2), 3).notable).toBe(false);
    // А вот пять при обычных двух — уже разговор.
    expect(deviationOf(steady(2), 5).notable).toBe(true);
  });

  it("на ровных рядах наблюдения всё равно упорядочиваются по силе", () => {
    // Иначе в сводку первым попадёт не самое заметное, а то, что раньше в списке.
    const weak = deviationOf(steady(10), 20).score;
    const strong = deviationOf(steady(10), 80).score;
    expect(strong).toBeGreaterThan(weak);
  });

  it("на нулевой истории любое появление значимо", () => {
    // Неявок не было ни разу, и вдруг три: разброса нет, доли нет — говорим.
    expect(deviationOf(steady(0), 3).notable).toBe(true);
    expect(deviationOf(steady(0), 0).notable).toBe(false);
  });

  it("мелочь по абсолютной величине не обсуждается, как бы ни скакала доля", () => {
    const d = deviationOf(steady(1), 2, 5);
    expect(d.skipped).toBe("too-small");
    expect(d.notable).toBe(false);
  });

  it("направление называется всегда, даже когда говорить не о чем", () => {
    expect(deviationOf(steady(100), 40).direction).toBe("down");
    expect(deviationOf(steady(100), 160).direction).toBe("up");
    expect(deviationOf([1, 2], 0).direction).toBe("down");
  });
});

describe("пустая неделя", () => {
  it("неделя с двумя приёмами при обычных тридцати — не материал для разбора", () => {
    expect(tooQuiet(2, steady(30))).toBe(true);
    expect(tooQuiet(28, steady(30))).toBe(false);
  });

  it("без истории тихой считается только пустая неделя", () => {
    expect(tooQuiet(0, [])).toBe(true);
    expect(tooQuiet(1, [])).toBe(false);
  });
});

describe("медиана", () => {
  it("чётная длина берёт середину между соседями", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBe(0);
  });
});
