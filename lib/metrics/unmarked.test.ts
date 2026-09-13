import { describe, expect, it } from "vitest";
import { explainUnmarked, MOVE_GRACE_MIN, type KnownMove, type OtherBooking, type UnmarkedVisit } from "./unmarked";

const NOW = new Date("2026-09-11T20:00:00+03:00");
const at = (iso: string) => new Date(iso);

const visit = (p: Partial<UnmarkedVisit> = {}): UnmarkedVisit => ({
  appointmentId: "a1",
  patientId: "p1",
  startAt: at("2026-09-11T10:00:00+03:00"),
  endedAt: at("2026-09-11T11:00:00+03:00"),
  ...p,
});

describe("почему приём остался без отметки", () => {
  it("записанный выгрузкой перенос — это факт, а не догадка", () => {
    const moves: KnownMove[] = [
      { fromStartAt: at("2026-09-11T10:00:00+03:00"), toStartAt: at("2026-09-14T15:00:00+03:00"), exact: true },
    ];
    const v = explainUnmarked(visit(), moves, [], NOW);
    expect(v.kind).toBe("moved");
    expect(v.movedTo).toEqual(at("2026-09-14T15:00:00+03:00"));
  });

  it("чужой перенос к этой записи не относится", () => {
    // У пациента бывает несколько записей; сверяем по времени слота.
    const moves: KnownMove[] = [
      { fromStartAt: at("2026-09-11T17:00:00+03:00"), toStartAt: at("2026-09-13T09:00:00+03:00"), exact: true },
    ];
    expect(explainUnmarked(visit(), moves, [], NOW).kind).not.toBe("moved");
  });

  it("запись, заведённая ПОСЛЕ приёма, — повод заподозрить перенос", () => {
    const others: OtherBooking[] = [
      {
        appointmentId: "a2",
        startAt: at("2026-09-14T15:00:00+03:00"),
        createdAt: at("2026-09-11T12:30:00+03:00"),
      },
    ];
    const v = explainUnmarked(visit(), [], others, NOW);
    expect(v.kind).toBe("maybe_moved");
    expect(v.reason).toContain("после этого приёма");
  });

  it("запись, заведённая ЗАРАНЕЕ, переносом не считается", () => {
    // Человек мог записаться на два приёма сразу — это не перенос.
    const others: OtherBooking[] = [
      {
        appointmentId: "a2",
        startAt: at("2026-09-14T15:00:00+03:00"),
        createdAt: at("2026-09-01T09:00:00+03:00"),
      },
    ];
    expect(explainUnmarked(visit(), [], others, NOW).kind).toBe("forgotten");
  });

  it("сразу после приёма судить рано: выгрузка могла не узнать о переносе", () => {
    const justEnded = visit({
      startAt: new Date(NOW.getTime() - 70 * 60_000),
      endedAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    expect(explainUnmarked(justEnded, [], [], NOW).kind).toBe("too_early");
  });

  it("висит дольше запаса и следов переноса нет — отметку забыли", () => {
    const old = visit({
      startAt: new Date(NOW.getTime() - (MOVE_GRACE_MIN + 90) * 60_000),
      endedAt: new Date(NOW.getTime() - (MOVE_GRACE_MIN + 30) * 60_000),
    });
    expect(explainUnmarked(old, [], [], NOW).kind).toBe("forgotten");
  });

  it("у каждого вывода есть основание словами", () => {
    for (const v of [
      explainUnmarked(visit(), [], [], NOW),
      explainUnmarked(visit({ endedAt: new Date(NOW.getTime() - 60_000) }), [], [], NOW),
    ]) {
      expect(v.reason.length).toBeGreaterThan(10);
    }
  });
});
