import { describe, expect, it } from "vitest";
import {
  firstReplyMinutes,
  fromPlatform,
  isFeature,
  median,
  platformShare,
  type OutgoingMessage,
  type ReplyEvent,
} from "./adoption";

const out = (p: Partial<OutgoingMessage>): OutgoingMessage => ({
  at: new Date("2026-09-10T10:00:00Z"),
  viaPlatform: false,
  authorId: null,
  fromBot: false,
  ...p,
});

describe("доля ответов из платформы", () => {
  it("отметка платформы решает, автор — запасной признак для истории", () => {
    expect(fromPlatform(out({ viaPlatform: true, authorId: null }))).toBe(true);
    expect(fromPlatform(out({ viaPlatform: false, authorId: "u1" }))).toBe(true);
    expect(fromPlatform(out({}))).toBe(false);
  });

  it("считает наши против телефонных", () => {
    const s = platformShare([
      out({ viaPlatform: true }),
      out({ viaPlatform: true }),
      out({}),
      out({}),
    ]);
    expect(s).toEqual({ ours: 2, phone: 2, share: 0.5 });
  });

  it("ответы агента в долю не идут: они не про переход администратора", () => {
    const s = platformShare([out({ fromBot: true }), out({ viaPlatform: true })]);
    expect(s).toEqual({ ours: 1, phone: 0, share: 1 });
  });

  it("ответов не было — доли нет, а не ноль", () => {
    expect(platformShare([]).share).toBeNull();
    expect(platformShare([out({ fromBot: true })]).share).toBeNull();
  });
});

const ev = (iso: string, direction: "IN" | "OUT", byStaff = true): ReplyEvent => ({
  at: new Date(iso),
  direction,
  byStaff,
});

describe("время первого ответа", () => {
  it("считается от первой реплики подряд до ответа человека", () => {
    const w = firstReplyMinutes([
      ev("2026-09-10T10:00:00Z", "IN"),
      ev("2026-09-10T10:02:00Z", "IN"),
      ev("2026-09-10T10:12:00Z", "OUT"),
    ]);
    expect(w).toEqual([12]);
  });

  it("ответ агента ожидание не закрывает", () => {
    const w = firstReplyMinutes([
      ev("2026-09-10T10:00:00Z", "IN"),
      ev("2026-09-10T10:01:00Z", "OUT", false),
      ev("2026-09-10T10:30:00Z", "OUT"),
    ]);
    expect(w).toEqual([30]);
  });

  it("несколько кругов переписки дают несколько чисел", () => {
    const w = firstReplyMinutes([
      ev("2026-09-10T10:00:00Z", "IN"),
      ev("2026-09-10T10:05:00Z", "OUT"),
      ev("2026-09-10T11:00:00Z", "IN"),
      ev("2026-09-10T11:20:00Z", "OUT"),
    ]);
    expect(w).toEqual([5, 20]);
  });

  it("неотвеченное ожидание в счёт не идёт", () => {
    expect(firstReplyMinutes([ev("2026-09-10T10:00:00Z", "IN")])).toEqual([]);
  });

  it("медиана устойчива к ночному выбросу", () => {
    expect(median([5, 7, 9, 720])).toBe(8);
    expect(median([])).toBeNull();
  });
});

describe("список приёмов работы", () => {
  it("закрытый: чужого ключа не бывает", () => {
    expect(isFeature("template")).toBe(true);
    expect(isFeature("что-угодно")).toBe(false);
  });
});
