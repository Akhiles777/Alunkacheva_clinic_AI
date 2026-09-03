import { describe, expect, it } from "vitest";
import { agentSavings, manualMedians, MANUAL_CAP_MS, MIN_SAMPLES } from "./agent-savings";

const MIN = 60 * 1000;

/** Пять ручных ответов по теме — ровно столько, чтобы база сравнения годилась. */
const fiveAnswers = (topic: string, ms: number) =>
  Array.from({ length: MIN_SAMPLES }, () => ({ topic, ms }));

describe("медиана ручного ответа", () => {
  it("обрезает сверху получасом до расчёта медианы", () => {
    // Ответ через восемь часов — это не время написания, а время, пока до
    // сообщения дошли руки. Без обрезки он тянул бы медиану всей темы.
    const m = manualMedians([
      { topic: "адрес", ms: 2 * MIN },
      { topic: "адрес", ms: 3 * MIN },
      { topic: "адрес", ms: 8 * 60 * MIN },
    ]);
    expect(m.get("адрес")!.ms).toBe(3 * MIN);
    expect(m.get("адрес")!.samples).toBe(3);
  });

  it("отрицательное время игнорирует", () => {
    const m = manualMedians([{ topic: "адрес", ms: -5 }]);
    expect(m.has("адрес")).toBe(false);
  });

  it("обрезка не превращает всё в предел", () => {
    const m = manualMedians([{ topic: "цены", ms: 40 * MIN }]);
    expect(m.get("цены")!.ms).toBe(MANUAL_CAP_MS);
  });
});

describe("сэкономленное время", () => {
  it("считает по темам с достаточной базой сравнения", () => {
    const r = agentSavings({
      closedByTopic: [{ topic: "адрес", count: 10 }],
      manual: fiveAnswers("адрес", 3 * MIN),
      escalations: 0,
      escalationCostMs: 0,
    });
    expect(r.byTopic).toHaveLength(1);
    expect(r.savedMs).toBe(10 * 3 * MIN);
    expect(r.skippedTopics).toHaveLength(0);
  });

  /**
   * Главная защита от приписок: тему без базы сравнения не считаем вовсе и
   * говорим об этом вслух. Подставить «среднее по больнице» значит выдать
   * догадку за факт.
   */
  it("тему с малой базой не считает, а называет отдельно", () => {
    const r = agentSavings({
      closedByTopic: [
        { topic: "адрес", count: 10 },
        { topic: "парковка", count: 7 },
      ],
      manual: [
        ...fiveAnswers("адрес", 3 * MIN),
        // По парковке администратор отвечал дважды — этого мало.
        { topic: "парковка", ms: 4 * MIN },
        { topic: "парковка", ms: 6 * MIN },
      ],
      escalations: 0,
      escalationCostMs: 0,
    });
    expect(r.byTopic.map((t) => t.topic)).toEqual(["адрес"]);
    expect(r.skippedTopics).toEqual([{ topic: "парковка", closed: 7, samples: 2 }]);
    // Вклад пропущенной темы в итог не попал.
    expect(r.savedMs).toBe(10 * 3 * MIN);
  });

  it("тема без единого ручного ответа тоже пропускается", () => {
    const r = agentSavings({
      closedByTopic: [{ topic: "не спрашивали руками", count: 3 }],
      manual: [],
      escalations: 0,
      escalationCostMs: 0,
    });
    expect(r.savedMs).toBe(0);
    expect(r.skippedTopics[0]).toEqual({ topic: "не спрашивали руками", closed: 3, samples: 0 });
  });

  /**
   * Встречное число обязательно: агент, отдавший половину разговоров, «сэкономил»
   * время, которое сам же и потратил чужими руками.
   */
  it("возвращает встречное число — сколько досталось людям", () => {
    const r = agentSavings({
      closedByTopic: [{ topic: "адрес", count: 4 }],
      manual: fiveAnswers("адрес", 2 * MIN),
      escalations: 12,
      escalationCostMs: 12 * 5 * MIN,
    });
    expect(r.escalations).toBe(12);
    expect(r.escalationCostMs).toBe(60 * MIN);
    // Экономия меньше затрат — и это видно, а не спрятано.
    expect(r.savedMs).toBeLessThan(r.escalationCostMs);
  });

  it("пустой период — ноль экономии и пустые списки", () => {
    const r = agentSavings({ closedByTopic: [], manual: [], escalations: 0, escalationCostMs: 0 });
    expect(r.savedMs).toBe(0);
    expect(r.byTopic).toEqual([]);
    expect(r.skippedTopics).toEqual([]);
  });

  it("темы упорядочены по вкладу", () => {
    const r = agentSavings({
      closedByTopic: [
        { topic: "адрес", count: 2 },
        { topic: "часы", count: 20 },
      ],
      manual: [...fiveAnswers("адрес", 3 * MIN), ...fiveAnswers("часы", 2 * MIN)],
      escalations: 0,
      escalationCostMs: 0,
    });
    expect(r.byTopic[0].topic).toBe("часы");
  });
});
