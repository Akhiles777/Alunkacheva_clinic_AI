import { describe, expect, it } from "vitest";
import { EMPTY_WATCH, queueVerdict } from "./queue-rule";

const MIN = 60_000;
const t0 = Date.UTC(2026, 9, 12, 10, 0);

describe("queueVerdict", () => {
  it("пустая очередь — ничего не делаем и забываем прошлое", () => {
    expect(queueVerdict({ headId: "a", headSince: t0 }, [], t0 + MIN)).toEqual({ clear: false, reason: null, next: EMPTY_WATCH });
  });

  it("первое появление — только запоминаем", () => {
    const v = queueVerdict(EMPTY_WATCH, [{ id: "a" }], t0);
    expect(v.clear).toBe(false);
    expect(v.next).toEqual({ headId: "a", headSince: t0 });
  });

  it("очередь движется (рассылка) — не трогаем, даже если сообщения в ней старые", () => {
    const old = new Date(t0 - 10 * MIN);
    const v = queueVerdict({ headId: "a", headSince: t0 - 6 * MIN }, [{ id: "b", ourCreatedAt: old }], t0);
    expect(v.clear).toBe(false);
    expect(v.next).toEqual({ headId: "b", headSince: t0 });
  });

  it("очередь стоит пять минут — чистим", () => {
    const v = queueVerdict({ headId: "a", headSince: t0 }, [{ id: "a" }, { id: "b" }], t0 + 5 * MIN);
    expect(v.clear).toBe(true);
    expect(v.next).toEqual(EMPTY_WATCH);
  });

  it("очередь стоит минуту, но в ней наше сообщение старше пяти минут — чистим сразу", () => {
    const v = queueVerdict(
      { headId: "a", headSince: t0 },
      [{ id: "a", ourCreatedAt: new Date(t0 - 4 * MIN) }],
      t0 + MIN,
    );
    expect(v.clear).toBe(true);
  });

  it("очередь стоит, а пациент уже написал после нашего сообщения — чистим", () => {
    const v = queueVerdict({ headId: "a", headSince: t0 }, [{ id: "a", ourCreatedAt: new Date(t0), repliedAfter: true }], t0 + MIN);
    expect(v.clear).toBe(true);
    expect(v.reason).toMatch(/ответили/);
  });

  it("стоит меньше пяти минут, свежие сообщения и без ответа — ждём", () => {
    const v = queueVerdict({ headId: "a", headSince: t0 }, [{ id: "a", ourCreatedAt: new Date(t0) }], t0 + 2 * MIN);
    expect(v.clear).toBe(false);
    expect(v.next).toEqual({ headId: "a", headSince: t0 });
  });
});
