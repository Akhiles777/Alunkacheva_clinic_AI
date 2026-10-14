import { describe, expect, it } from "vitest";
import { applyView, viewCounts } from "./views";

const rows = [
  { id: "a", waitingSince: "2026-10-14T10:30:00Z", unread: true, escalated: false, firstTime: true },
  { id: "b", waitingSince: "2026-10-14T09:00:00Z", unread: true, escalated: true },
  // «Спасибо!» в конце прочитанной переписки — не ожидание.
  { id: "e", waitingSince: "2026-10-13T09:00:00Z", unread: false, escalated: false },
  { id: "c", waitingSince: null, escalated: false, scheduleChange: "cancel" as const },
  { id: "d", waitingSince: null, escalated: false },
];

describe("фильтры списка", () => {
  it("«Ждут ответа» — дольше ждущий первым", () => {
    expect(applyView(rows, "waiting").map((r) => r.id)).toEqual(["b", "a"]);
  });
  it("«Все» не переставляет строки", () => {
    expect(applyView(rows, "all").map((r) => r.id)).toEqual(["a", "b", "e", "c", "d"]);
  });
  it("срочные фильтры", () => {
    expect(applyView(rows, "human").map((r) => r.id)).toEqual(["b"]);
    expect(applyView(rows, "new").map((r) => r.id)).toEqual(["a"]);
    expect(applyView(rows, "schedule").map((r) => r.id)).toEqual(["c"]);
  });
  it("счётчики совпадают с фильтрами", () => {
    expect(viewCounts(rows)).toEqual({ all: 5, waiting: 2, human: 1, new: 1, schedule: 1 });
  });
});
