import { describe, expect, it } from "vitest";
import {
  buildDigest,
  capitalizeFirst,
  formatValue,
  MAX_OBSERVATIONS,
  type MetricSeries,
} from "./digest";

const steady = (v: number, n = 8) => Array.from({ length: n }, () => v);

/**
 * Восемь недель вокруг значения с настоящим небольшим разбросом.
 *
 * Ровный ряд для денег — фикстура, которой не бывает в жизни: у выручки
 * недели никогда не совпадают до рубля, и правило «плоский ряд должен
 * удвоиться» проверялось бы не на том, для чего оно написано.
 * Медиана этого ряда равна `base` ровно.
 */
const around = (base: number, step: number): number[] =>
  [-4, -2, -1, 0, 0, 1, 2, 4].map((k) => base + k * step);

const series = (p: Partial<MetricSeries> = {}): MetricSeries => ({
  key: "revenue",
  title: "Выручка недели",
  history: around(200_000, 1_000),
  current: 200_000,
  unit: "money",
  minAbsolute: 10_000,
  href: "/reports",
  worseWhen: "down",
  ...p,
});

const busy = { appointments: 30, appointmentsHistory: steady(30) };

describe("сводка недели", () => {
  it("спокойная неделя не выдумывает новостей", () => {
    const d = buildDigest({ series: [series()], ...busy });
    expect(d.observations).toEqual([]);
    expect(d.note).toContain("в пределах обычного");
  });

  it("выход за собственный разброс становится наблюдением с обоими числами", () => {
    const d = buildDigest({ series: [series({ current: 90_000 })], ...busy });
    expect(d.observations).toHaveLength(1);
    expect(d.observations[0].text).toContain("ниже обычного");
    expect(d.observations[0].text).toContain("обычно");
    expect(d.observations[0].worse).toBe(true);
  });

  it("наблюдений не больше пяти, и сильнейшие идут первыми", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      series({
        key: `m${i}`,
        title: `Метрика ${i}`,
        history: steady(100),
        // Чем больше i, тем сильнее отклонение.
        current: 100 + (i + 1) * 100,
        unit: "count",
        minAbsolute: 0,
      }),
    );
    const d = buildDigest({ series: many, ...busy });
    expect(d.observations).toHaveLength(MAX_OBSERVATIONS);
    expect(d.observations[0].key).toBe("m7");
  });

  it("пустая неделя называется прямо, а не разбирается по долям", () => {
    const d = buildDigest({
      series: [series({ current: 20_000 })],
      appointments: 3,
      appointmentsHistory: steady(30),
    });
    expect(d.observations).toEqual([]);
    expect(d.note).toContain("меньше обычного");
    expect(d.note).toContain("3");
  });

  it("без восьми недель истории показываем значения и говорим, почему нет сравнения", () => {
    const d = buildDigest({
      series: [series({ history: [190_000, 210_000], current: 90_000 })],
      appointments: 30,
      appointmentsHistory: [30, 30],
    });
    expect(d.hasBaseline).toBe(false);
    expect(d.note).toContain("восемь полных недель");
    expect(d.observations).toHaveLength(1);
    // Никакого «ниже обычного»: нормы у нас нет.
    expect(d.observations[0].text).not.toContain("обычно");
    expect(d.observations[0].hypothesis).toBeNull();
  });
});

describe("гипотеза о причине", () => {
  it("падение выручки при обычном числе приёмов объясняется составом услуг", () => {
    const d = buildDigest({
      series: [
        series({ current: 90_000 }),
        series({
          key: "arrived",
          title: "Приёмы",
          history: around(30, 1),
          current: 30,
          unit: "count",
          minAbsolute: 0,
          worseWhen: "down",
        }),
      ],
      ...busy,
    });
    expect(d.observations[0].hypothesis).toContain("составе услуг");
    expect(d.observations[0].hypothesis).toContain("возможно");
  });

  it("падение выручки вместе с приёмами объясняется потоком", () => {
    const d = buildDigest({
      series: [
        series({ current: 90_000 }),
        series({
          key: "arrived",
          title: "Приёмы",
          history: around(30, 1),
          current: 10,
          unit: "count",
          minAbsolute: 0,
          worseWhen: "down",
        }),
      ],
      appointments: 10,
      appointmentsHistory: steady(30).map(() => 12),
    });
    const revenue = d.observations.find((o) => o.key === "revenue")!;
    expect(revenue.hypothesis).toContain("потоке пациентов");
  });

  it("без второго числа причина не выдумывается", () => {
    const d = buildDigest({ series: [series({ current: 90_000 })], ...busy });
    expect(d.observations[0].hypothesis).toBeNull();
  });

  it("рост неразобранных подписан как вопрос к отметкам, а не к пациентам", () => {
    const d = buildDigest({
      series: [
        series({
          key: "unmarked",
          title: "Неразобранные визиты",
          history: steady(1),
          current: 12,
          unit: "count",
          minAbsolute: 2,
          worseWhen: "up",
        }),
      ],
      ...busy,
    });
    expect(d.observations[0].hypothesis).toContain("не про пациентов");
  });
});

describe("оговорка в гипотезе", () => {
  it("стоит ровно один раз: рендер её не приписывает", () => {
    const d = buildDigest({
      series: [
        series({ current: 90_000 }),
        series({
          key: "arrived",
          title: "Приёмы",
          history: around(30, 1),
          current: 30,
          unit: "count",
          minAbsolute: 0,
          worseWhen: "down",
        }),
      ],
      ...busy,
    });
    const h = d.observations[0].hypothesis!;
    expect(h.match(/возможно/gi)).toHaveLength(1);
    expect(capitalizeFirst(h).match(/возможно/gi)).toHaveLength(1);
  });
});

describe("формат чисел", () => {
  it("деньги, доли, минуты и штуки подписаны по-разному", () => {
    expect(formatValue(200000, "money")).toContain("₽");
    expect(formatValue(12.34, "percent")).toBe("12.3%");
    expect(formatValue(7.6, "minutes")).toBe("8 мин");
    expect(formatValue(30, "count")).toBe("30");
  });
});
