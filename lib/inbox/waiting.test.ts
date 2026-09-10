import { describe, expect, it } from "vitest";
import { compareQueue, unreadCount, waitLabel, waitingSince, type QueueMessage } from "./waiting";

const at = (iso: string, direction: "IN" | "OUT" = "IN"): QueueMessage => ({
  direction,
  createdAt: new Date(iso),
});

describe("сколько пациент ждёт", () => {
  it("ждёт с первой реплики подряд, а не с последней", () => {
    const since = waitingSince([
      at("2026-09-09T10:00:00Z", "OUT"),
      at("2026-09-09T10:05:00Z"),
      at("2026-09-09T10:06:00Z"),
      at("2026-09-09T10:07:00Z"),
    ]);
    expect(since?.toISOString()).toBe("2026-09-09T10:05:00.000Z");
  });

  it("ответили — ожидание кончилось", () => {
    expect(
      waitingSince([at("2026-09-09T10:05:00Z"), at("2026-09-09T10:06:00Z", "OUT")]),
    ).toBeNull();
  });

  it("порядок сообщений на входе не важен", () => {
    const since = waitingSince([
      at("2026-09-09T10:07:00Z"),
      at("2026-09-09T10:00:00Z", "OUT"),
      at("2026-09-09T10:05:00Z"),
    ]);
    expect(since?.toISOString()).toBe("2026-09-09T10:05:00.000Z");
  });
});

describe("непрочитанные", () => {
  it("считаются от отметки прочтения", () => {
    const msgs = [
      at("2026-09-09T10:00:00Z"),
      at("2026-09-09T10:05:00Z"),
      at("2026-09-09T10:06:00Z"),
    ];
    expect(unreadCount(msgs, new Date("2026-09-09T10:04:00Z"))).toBe(2);
  });

  it("без отметки — от нашего последнего ответа, а не вся история", () => {
    const msgs = [
      at("2026-09-08T09:00:00Z"),
      at("2026-09-08T09:01:00Z"),
      at("2026-09-08T09:02:00Z", "OUT"),
      at("2026-09-09T10:05:00Z"),
    ];
    expect(unreadCount(msgs, null)).toBe(1);
  });

  it("свои сообщения непрочитанными не бывают", () => {
    expect(unreadCount([at("2026-09-09T10:00:00Z", "OUT")], null)).toBe(0);
  });
});

describe("подпись ожидания", () => {
  it("меньше минуты не показываем: «ждёт 0 мин» выглядит поломкой", () => {
    expect(waitLabel(30_000)).toBeNull();
  });
  it("минуты, часы и дни склоняются", () => {
    expect(waitLabel(12 * 60_000)).toBe("ждёт 12 мин");
    expect(waitLabel(60 * 60_000)).toBe("ждёт 1 час");
    expect(waitLabel(3 * 3600_000)).toBe("ждёт 3 часа");
    expect(waitLabel(7 * 3600_000)).toBe("ждёт 7 часов");
    expect(waitLabel(2 * 86_400_000)).toBe("ждёт 2 дня");
  });
});

describe("порядок списка", () => {
  const row = (waiting: string | null, atMs: number, escalated = false) => ({
    waitingSince: waiting,
    at: atMs,
    escalated,
  });

  it("дольше ждущий выше", () => {
    const rows = [
      row("2026-09-09T10:50:00Z", 5),
      row("2026-09-09T10:10:00Z", 9),
      row(null, 100),
    ].sort(compareQueue);
    expect(rows[0].waitingSince).toBe("2026-09-09T10:10:00Z");
    expect(rows[2].waitingSince).toBeNull();
  });

  it("эскалация поднимается над обычным ожиданием", () => {
    const rows = [row("2026-09-09T10:00:00Z", 1), row("2026-09-09T11:00:00Z", 2, true)].sort(
      compareQueue,
    );
    expect(rows[0].escalated).toBe(true);
  });

  it("не ждущие идут по времени последнего сообщения", () => {
    const rows = [row(null, 10), row(null, 30), row(null, 20)].sort(compareQueue);
    expect(rows.map((r) => r.at)).toEqual([30, 20, 10]);
  });

  it("порядок устойчив: равные значения не прыгают между обновлениями", () => {
    const rows = [row(null, 10), row(null, 10)];
    expect(compareQueue(rows[0], rows[1])).toBe(0);
  });
});
