import { describe, expect, it } from "vitest";
import {
  bonusActions,
  canAttribute,
  schoolTotals,
  type AttributionFact,
  type PromoRule,
  type VisitFact,
} from "./partner-bonus";

const OSTEO = 101;
const BOS = 102;
const LAB = 103;
const OTHER = 999;

const promo: PromoRule = {
  serviceIds: [OSTEO, BOS, LAB],
  startsAt: new Date("2026-10-01T00:00:00Z"),
  endsAt: new Date("2026-11-15T20:59:59Z"),
};

const d = (s: string) => new Date(s);

function visit(
  id: string,
  at: string,
  services: number[],
  status = "ARRIVED",
  extra: Partial<VisitFact> = {},
): VisitFact {
  return {
    id,
    startAt: d(at),
    status,
    deleted: false,
    services: services.map((n) => ({ yclientsServiceId: n, quantity: 1 })),
    ...extra,
  };
}

function attr(
  id: string,
  extra: Partial<AttributionFact> = {},
): AttributionFact {
  return {
    id,
    childNo: 1,
    attributedAt: d("2026-10-05T10:00:00Z"),
    removed: false,
    bonusAmountFrozen: 500,
    bonus: null,
    ...extra,
  };
}

describe("бонус школе — один на привязку", () => {
  it("первый пришедший визит с услугой акции начисляет бонус", () => {
    const acts = bonusActions(
      promo,
      [attr("a1")],
      [visit("v1", "2026-10-10T09:00:00Z", [OSTEO])],
    );
    expect(acts).toEqual([
      {
        kind: "earn",
        attributionId: "a1",
        appointmentId: "v1",
        amount: 500,
        earnedAt: d("2026-10-10T09:00:00Z"),
      },
    ]);
  });

  it("четыре отдельные услуги пакета — один бонус, не четыре", () => {
    const visits = [
      visit("v1", "2026-10-10T09:00:00Z", [OSTEO]),
      visit("v2", "2026-10-11T09:00:00Z", [BOS]),
      visit("v3", "2026-10-12T09:00:00Z", [LAB]),
    ];
    const acts = bonusActions(promo, [attr("a1")], visits);
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ kind: "earn", appointmentId: "v1" });
  });

  it("одна комплексная запись со всеми услугами — тоже один бонус", () => {
    const acts = bonusActions(
      promo,
      [attr("a1")],
      [visit("v1", "2026-10-10T09:00:00Z", [OSTEO, BOS, LAB])],
    );
    expect(acts).toHaveLength(1);
  });

  it("повторный пересчёт после начисления ничего не делает", () => {
    const visits = [
      visit("v1", "2026-10-10T09:00:00Z", [OSTEO]),
      visit("v2", "2026-10-11T09:00:00Z", [BOS]),
    ];
    const earned = attr("a1", {
      bonus: { id: "b1", status: "EARNED", triggeredByAppointmentId: "v1" },
    });
    expect(bonusActions(promo, [earned], visits)).toEqual([]);
  });

  it("сумма — замороженная в привязке", () => {
    const acts = bonusActions(
      promo,
      [attr("a1", { bonusAmountFrozen: 300 })],
      [visit("v1", "2026-10-10T09:00:00Z", [OSTEO])],
    );
    expect(acts[0]).toMatchObject({ amount: 300 });
  });
});

describe("условия начисления", () => {
  it("визит не пришедший — бонуса нет", () => {
    for (const status of ["CREATED", "CONFIRMED", "CANCELLED", "NO_SHOW"]) {
      expect(
        bonusActions(
          promo,
          [attr("a1")],
          [visit("v1", "2026-10-10T09:00:00Z", [OSTEO], status)],
        ),
      ).toEqual([]);
    }
  });

  it("услуга не из акции — бонуса нет", () => {
    expect(
      bonusActions(
        promo,
        [attr("a1")],
        [visit("v1", "2026-10-10T09:00:00Z", [OTHER])],
      ),
    ).toEqual([]);
  });

  it("визит раньше привязки не засчитывается, следующий — да", () => {
    const visits = [
      visit("v0", "2026-10-03T09:00:00Z", [OSTEO]),
      visit("v1", "2026-10-10T09:00:00Z", [BOS]),
    ];
    expect(bonusActions(promo, [attr("a1")], visits)[0]).toMatchObject({
      appointmentId: "v1",
    });
  });

  it("визит позже конца акции + 30 дней — бонуса нет; в пределах 30 дней — есть", () => {
    expect(
      bonusActions(
        promo,
        [attr("a1")],
        [visit("v1", "2026-12-16T09:00:00Z", [OSTEO])],
      ),
    ).toEqual([]);
    expect(
      bonusActions(
        promo,
        [attr("a1")],
        [visit("v1", "2026-12-14T09:00:00Z", [OSTEO])],
      ),
    ).toHaveLength(1);
  });

  it("удалённая запись не засчитывается", () => {
    const v = visit("v1", "2026-10-10T09:00:00Z", [OSTEO], "ARRIVED", {
      deleted: true,
    });
    expect(bonusActions(promo, [attr("a1")], [v])).toEqual([]);
  });

  it("снятая привязка бонус не получает", () => {
    expect(
      bonusActions(
        promo,
        [attr("a1", { removed: true })],
        [visit("v1", "2026-10-10T09:00:00Z", [OSTEO])],
      ),
    ).toEqual([]);
  });
});

describe("снятие бонуса — с причиной", () => {
  const earned = attr("a1", {
    bonus: { id: "b1", status: "EARNED", triggeredByAppointmentId: "v1" },
  });

  it.each([
    ["CANCELLED", "визит отменён"],
    ["NO_SHOW", "неявка"],
    ["CONFIRMED", "снята отметка «пришёл»"],
  ])("визит стал %s → REVERSED «%s»", (status, reason) => {
    const acts = bonusActions(
      promo,
      [earned],
      [visit("v1", "2026-10-10T09:00:00Z", [OSTEO], status)],
    );
    expect(acts).toEqual([
      { kind: "reverse", bonusId: "b1", attributionId: "a1", reason },
    ]);
  });

  it("запись удалили в YCLIENTS", () => {
    const v = visit("v1", "2026-10-10T09:00:00Z", [OSTEO], "ARRIVED", {
      deleted: true,
    });
    expect(bonusActions(promo, [earned], [v])[0]).toMatchObject({
      reason: "визит удалён в YCLIENTS",
    });
  });

  it("привязку сняли", () => {
    const acts = bonusActions(
      promo,
      [{ ...earned, removed: true }],
      [visit("v1", "2026-10-10T09:00:00Z", [OSTEO])],
    );
    expect(acts[0]).toMatchObject({
      kind: "reverse",
      reason: "привязка снята",
    });
  });

  it("снятый бонус сам не возвращается и не начисляется заново", () => {
    const reversed = attr("a1", {
      bonus: { id: "b1", status: "REVERSED", triggeredByAppointmentId: "v1" },
    });
    const visits = [
      visit("v1", "2026-10-10T09:00:00Z", [OSTEO], "CANCELLED"),
      visit("v2", "2026-10-20T09:00:00Z", [OSTEO]),
    ];
    expect(bonusActions(promo, [reversed], visits)).toEqual([]);
  });
});

describe("привязку сняли и поставили заново", () => {
  it("после повторной привязки бонус считается заново той же строкой", () => {
    const a = attr("a1", {
      attributedAt: d("2026-10-20T10:00:00Z"),
      bonus: {
        id: "b1",
        status: "REVERSED",
        triggeredByAppointmentId: "v1",
        reversedAt: d("2026-10-15T10:00:00Z"),
      },
    });
    const acts = bonusActions(
      promo,
      [a],
      [visit("v2", "2026-10-22T09:00:00Z", [OSTEO])],
    );
    expect(acts).toEqual([
      {
        kind: "earn",
        attributionId: "a1",
        appointmentId: "v2",
        amount: 500,
        earnedAt: d("2026-10-22T09:00:00Z"),
        bonusId: "b1",
      },
    ]);
  });
});

describe("двое детей одной семьи", () => {
  it("второй ребёнок на той же карточке: бонус — только когда услуга повторилась", () => {
    const first = attr("a1", {
      bonus: { id: "b1", status: "EARNED", triggeredByAppointmentId: "v1" },
    });
    const second = attr("a2", { childNo: 2 });
    // Остальные части пакета первого ребёнка — это не второй ребёнок.
    const visits = [
      visit("v1", "2026-10-10T09:00:00Z", [OSTEO]),
      visit("v2", "2026-10-11T09:00:00Z", [BOS]),
      visit("v3", "2026-10-12T09:00:00Z", [LAB]),
    ];
    expect(bonusActions(promo, [first, second], visits)).toEqual([]);
    // Приём остеопата второй раз — второй человек.
    const more = [...visits, visit("v4", "2026-10-15T09:00:00Z", [OSTEO])];
    expect(bonusActions(promo, [first, second], more)).toEqual([
      {
        kind: "earn",
        attributionId: "a2",
        appointmentId: "v4",
        amount: 500,
        earnedAt: d("2026-10-15T09:00:00Z"),
      },
    ]);
  });

  it("оба ребёнка одной записью с количеством 2 — два бонуса", () => {
    const v: VisitFact = {
      id: "v1",
      startAt: d("2026-10-10T09:00:00Z"),
      status: "ARRIVED",
      deleted: false,
      services: [{ yclientsServiceId: OSTEO, quantity: 2 }],
    };
    const acts = bonusActions(
      promo,
      [attr("a1"), attr("a2", { childNo: 2 })],
      [v],
    );
    expect(acts.map((a) => a.kind === "earn" && a.attributionId)).toEqual([
      "a1",
      "a2",
    ]);
  });

  it("одна запись без повтора услуги — второму ребёнку бонуса нет", () => {
    const acts = bonusActions(
      promo,
      [attr("a1"), attr("a2", { childNo: 2 })],
      [visit("v1", "2026-10-10T09:00:00Z", [OSTEO, BOS])],
    );
    expect(acts).toHaveLength(1);
  });

  it("второй ребёнок со своей карточкой считается по своим визитам", () => {
    expect(
      bonusActions(
        promo,
        [attr("c1")],
        [visit("w1", "2026-10-12T09:00:00Z", [OSTEO])],
      ),
    ).toHaveLength(1);
  });
});

describe("итоги школы и окно привязки", () => {
  it("снятые стоят отдельно, снятые привязки не считаются привязанными", () => {
    const t = schoolTotals([
      { removed: false, bonus: { status: "EARNED", amount: 500 } },
      { removed: false, bonus: null },
      { removed: true, bonus: { status: "REVERSED", amount: 500 } },
      { removed: false, bonus: { status: "REVERSED", amount: 500 } },
    ]);
    expect(t).toEqual({
      attributed: 3,
      arrived: 1,
      bonusEarned: 500,
      reversed: 2,
      bonusReversed: 1000,
    });
  });

  it("пустая школа — нули числом", () => {
    expect(schoolTotals([])).toEqual({
      attributed: 0,
      arrived: 0,
      bonusEarned: 0,
      reversed: 0,
      bonusReversed: 0,
    });
  });

  it("после конца акции новые привязки не заводятся", () => {
    const p = { isActive: true, endsAt: d("2026-11-15T20:59:59Z") };
    expect(canAttribute(p, d("2026-11-10T00:00:00Z"))).toBe(true);
    expect(canAttribute(p, d("2026-11-16T00:00:00Z"))).toBe(false);
    expect(
      canAttribute({ ...p, isActive: false }, d("2026-11-10T00:00:00Z")),
    ).toBe(false);
  });
});

describe("ручное не перетирается", () => {
  const v = (id: string, status = "ARRIVED") => ({
    id,
    startAt: new Date("2026-10-10T09:00:00Z"),
    status,
    deleted: false,
    services: [{ yclientsServiceId: 101, quantity: 1 }],
  });
  const p: PromoRule = { serviceIds: [101], startsAt: new Date("2026-10-01T00:00:00Z"), endsAt: new Date("2026-11-15T20:59:59Z") };
  const base = { id: "a1", childNo: 1, attributedAt: new Date("2026-10-05T00:00:00Z"), removed: false, bonusAmountFrozen: 500 };

  it("бонус, поставленный руками, пересчёт не снимает даже при отмене визита", () => {
    const a = { ...base, bonus: { id: "b1", status: "EARNED" as const, triggeredByAppointmentId: null, manual: true } };
    expect(bonusActions(p, [a], [v("v1", "CANCELLED")])).toEqual([]);
  });

  it("снятый руками бонус пересчёт не возвращает", () => {
    const a = { ...base, bonus: { id: "b1", status: "REVERSED" as const, triggeredByAppointmentId: null, manual: true, reversedAt: new Date("2026-10-01T00:00:00Z") } };
    expect(bonusActions(p, [a], [v("v1")])).toEqual([]);
  });

  it("участник без школы бонуса не получает", () => {
    expect(bonusActions(p, [{ ...base, bonus: null, hasSchool: false }], [v("v1")])).toEqual([]);
  });

  it("«прошёл» отмечено руками — автоматика бонус не дублирует", () => {
    expect(bonusActions(p, [{ ...base, bonus: null, completed: true }], [v("v1")])).toEqual([]);
  });
});
