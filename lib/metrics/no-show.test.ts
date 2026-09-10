import { describe, expect, it } from "vitest";
import {
  MIN_HISTORY_VISITS,
  MIN_SLOT_VISITS,
  noShowVerdict,
  predictable,
  type NoShowFacts,
  type NoShowWeights,
} from "./no-show";

/** Веса для теста — ровные, чтобы проверялись правила, а не арифметика. */
const W: NoShowWeights = {
  history: 1,
  horizon: 0.5,
  firstVisit: 0.3,
  unconfirmed: 0.5,
  slot: 1,
  courseOverdue: 0.4,
  moved: 0.4,
  threshold: 1,
};

const facts = (p: Partial<NoShowFacts> = {}): NoShowFacts => ({
  historyRate: null,
  historyVisits: 0,
  horizonDays: 2,
  firstVisit: false,
  unconfirmed: null,
  slotRate: null,
  slotVisits: 0,
  courseOverdue: null,
  moved: null,
  ...p,
});

describe("признаки риска — каждый отдельно", () => {
  it("история неявок: доля считается только от трёх визитов", () => {
    const мало = noShowVerdict(facts({ historyRate: 1, historyVisits: 2 }), W);
    expect(мало.reasons).toEqual([]);

    const хватает = noShowVerdict(
      facts({ historyRate: 0.4, historyVisits: MIN_HISTORY_VISITS + 2 }),
      W,
    );
    expect(хватает.reasons[0]).toBe("не пришёл 2 раза из 5");
  });

  it("пациент со стопроцентными неявками — повышенный риск", () => {
    const v = noShowVerdict(facts({ historyRate: 1, historyVisits: 4 }), W);
    expect(v.level).toBe("raised");
  });

  it("горизонт: близкая запись признаком не считается", () => {
    expect(noShowVerdict(facts({ horizonDays: 3 }), W).reasons).toEqual([]);
    expect(noShowVerdict(facts({ horizonDays: 24 }), W).reasons).toEqual(["записан за 24 дня"]);
  });

  it("первый визит сам по себе выше обычного не поднимает", () => {
    const v = noShowVerdict(facts({ firstVisit: true }), { ...W, firstVisit: 5 });
    expect(v.reasons).toEqual(["первый визит"]);
    expect(v.level).toBe("usual");
  });

  it("первый визит вместе с другим сигналом — уже повод", () => {
    const v = noShowVerdict(facts({ firstVisit: true, unconfirmed: true }), {
      ...W,
      firstVisit: 0.6,
      unconfirmed: 0.6,
    });
    expect(v.level).toBe("raised");
  });

  it("неподтверждённая запись", () => {
    expect(noShowVerdict(facts({ unconfirmed: true }), W).reasons).toEqual([
      "не ответил на сообщение клиники",
    ]);
    expect(noShowVerdict(facts({ unconfirmed: false }), W).reasons).toEqual([]);
  });

  it("слот: доля клиники берётся только на достаточной выборке", () => {
    expect(noShowVerdict(facts({ slotRate: 0.5, slotVisits: 5 }), W).reasons).toEqual([]);
    const v = noShowVerdict(facts({ slotRate: 0.3, slotVisits: MIN_SLOT_VISITS }), W);
    expect(v.reasons[0]).toContain("30%");
  });

  it("ритм курса и прошлый перенос", () => {
    expect(noShowVerdict(facts({ courseOverdue: true }), W).reasons).toEqual([
      "выпадает из ритма курса",
    ]);
    expect(noShowVerdict(facts({ moved: true }), W).reasons).toEqual(["запись уже переносили"]);
  });

  it("неизвестный признак не считается нулём и в основание не идёт", () => {
    const v = noShowVerdict(facts({ historyRate: null, unconfirmed: null, slotRate: null }), W);
    expect(v.score).toBe(0);
    expect(v.reasons).toEqual([]);
    expect(v.level).toBe("usual");
  });

  it("повторный расчёт на тех же данных даёт то же самое", () => {
    const f = facts({ historyRate: 0.5, historyVisits: 4, horizonDays: 30, moved: true });
    expect(noShowVerdict(f, W)).toEqual(noShowVerdict(f, W));
  });
});

describe("кому прогноз не считается", () => {
  const now = new Date("2026-09-10T10:00:00Z");
  const soon = new Date("2026-09-11T10:00:00Z");

  it("блокировка времени без пациента", () => {
    expect(predictable({ status: "CREATED", patientId: null, startAt: soon }, now)).toBe(false);
  });

  it("состоявшийся, отменённый и неявка", () => {
    for (const status of ["ARRIVED", "CANCELLED", "NO_SHOW"]) {
      expect(predictable({ status, patientId: "p", startAt: soon }, now)).toBe(false);
    }
  });

  it("визит в прошлом", () => {
    expect(
      predictable({ status: "CREATED", patientId: "p", startAt: new Date("2026-09-09T10:00:00Z") }, now),
    ).toBe(false);
  });

  it("обычная будущая запись — считается", () => {
    expect(predictable({ status: "CONFIRMED", patientId: "p", startAt: soon }, now)).toBe(true);
  });
});
