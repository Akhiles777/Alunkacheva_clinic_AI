import { describe, expect, it } from "vitest";
import { isRealMove, pairMoves, type MoveCandidate, type VanishedVisit } from "./reschedule";

const NOW = new Date("2026-09-10T12:00:00+03:00");
const at = (iso: string) => new Date(iso);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

const gone = (p: Partial<VanishedVisit> = {}): VanishedVisit => ({
  appointmentId: "old",
  patientId: "p1",
  startAt: at("2026-09-12T10:00:00+03:00"),
  ...p,
});

const fresh = (p: Partial<MoveCandidate> = {}): MoveCandidate => ({
  appointmentId: "new",
  patientId: "p1",
  startAt: at("2026-09-14T15:00:00+03:00"),
  createdAt: hoursAgo(1),
  ...p,
});

describe("перенос пересозданием", () => {
  it("исчезнувшая будущая запись и свежая запись того же пациента — перенос", () => {
    const moves = pairMoves([gone()], [fresh()], NOW);
    expect(moves).toHaveLength(1);
    expect(moves[0].fromStartAt).toEqual(at("2026-09-12T10:00:00+03:00"));
    expect(moves[0].toStartAt).toEqual(at("2026-09-14T15:00:00+03:00"));
    // Ссылка ведёт на запись в её НОВОМ виде: старой в YCLIENTS уже нет.
    expect(moves[0].appointmentId).toBe("new");
  });

  it("прошедший приём переносом не считается", () => {
    // Такие записи убирают по другим причинам: чистят ошибки, сводят дубли.
    expect(pairMoves([gone({ startAt: hoursAgo(48) })], [fresh()], NOW)).toEqual([]);
  });

  it("другой пациент в пару не идёт", () => {
    expect(pairMoves([gone()], [fresh({ patientId: "p2" })], NOW)).toEqual([]);
  });

  it("запись без пациента связать не с чем", () => {
    expect(pairMoves([gone({ patientId: null })], [fresh({ patientId: null })], NOW)).toEqual([]);
  });

  it("запись недельной давности — новое обращение, а не перенос", () => {
    expect(pairMoves([gone()], [fresh({ createdAt: hoursAgo(24 * 7) })], NOW)).toEqual([]);
  });

  it("совпавшее время означает ту же запись, а не перенос", () => {
    const same = at("2026-09-12T10:00:00+03:00");
    expect(pairMoves([gone({ startAt: same })], [fresh({ startAt: same })], NOW)).toEqual([]);
  });

  it("одну новую запись не приписываем двум исчезнувшим", () => {
    const moves = pairMoves(
      [gone({ appointmentId: "old1" }), gone({ appointmentId: "old2", startAt: at("2026-09-13T10:00:00+03:00") })],
      [fresh()],
      NOW,
    );
    expect(moves).toHaveLength(1);
  });

  it("из нескольких подходящих берём созданную последней", () => {
    const moves = pairMoves(
      [gone()],
      [
        fresh({ appointmentId: "early", createdAt: hoursAgo(20) }),
        fresh({ appointmentId: "late", createdAt: hoursAgo(2) }),
      ],
      NOW,
    );
    expect(moves[0].appointmentId).toBe("late");
  });
});

describe("перенос правкой той же записи", () => {
  it("сдвиг на часы — перенос", () => {
    expect(isRealMove(at("2026-09-12T10:00:00Z"), at("2026-09-12T14:00:00Z"))).toBe(true);
  });

  it("секунды из округлений провайдера переносом не считаются", () => {
    expect(isRealMove(at("2026-09-12T10:00:00Z"), at("2026-09-12T10:00:30Z"))).toBe(false);
  });

  it("перенос назад — тоже перенос", () => {
    expect(isRealMove(at("2026-09-12T14:00:00Z"), at("2026-09-12T10:00:00Z"))).toBe(true);
  });
});
