import { describe, expect, it } from "vitest";
import { createReadMarks, RETRY_DELAYS, SLOW_RETRY_MS } from "./read-marks";

/** Управляемое время и отложенные вызовы: тест не ждёт по-настоящему. */
function harness(results: (Error | null)[]) {
  let clock = 1000;
  const timers: { at: number; fn: () => void }[] = [];
  const sent: string[] = [];
  let n = 0;
  const failed: number[] = [];
  const marks = createReadMarks({
    send: async (id) => {
      sent.push(id);
      const r = results[n++] ?? null;
      if (r) throw r;
    },
    onFailed: (_id, _reason, tries) => failed.push(tries),
    now: () => clock,
    delay: (fn, ms) => timers.push({ at: clock + ms, fn }),
  });
  return {
    marks,
    sent,
    failed,
    tick: async (ms: number) => {
      clock += ms;
      for (const t of timers.filter((t) => t.at <= clock)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe("очередь отметок прочтения", () => {
  it("сбой записи повторяется сам, человека ни о чём не просят", async () => {
    const h = harness([new Error("Failed to fetch"), null]);
    h.marks.mark("d1", "m9");
    await h.tick(0);
    expect(h.sent).toEqual(["d1"]);
    expect(h.failed).toEqual([1]);
    // Пока не легло — экран держит диалог прочитанным.
    expect(h.marks.staysRead("d1", "m9")).toBe(true);

    await h.tick(RETRY_DELAYS[0]);
    expect(h.sent).toEqual(["d1", "d1"]);
    expect(h.marks.pending()).toBe(0);
    expect(h.marks.staysRead("d1", "m9")).toBe(false);
  });

  it("точка не загорается заново на опросе списка", async () => {
    const h = harness([new Error("502")]);
    h.marks.mark("d1", "m9");
    await h.tick(0);
    // Опрос пришёл со снимком, где диалог ещё непрочитан.
    expect(h.marks.staysRead("d1", "m9")).toBe(true);
  });

  it("после исчерпания быстрых попыток очередь остаётся и добирается кругом опроса", async () => {
    const h = harness([
      new Error("502"),
      new Error("502"),
      new Error("502"),
      new Error("502"),
      null,
    ]);
    h.marks.mark("d1", "m9");
    await h.tick(0);
    for (const d of RETRY_DELAYS) await h.tick(d);
    expect(h.sent.length).toBe(RETRY_DELAYS.length + 1);
    expect(h.marks.pending()).toBe(1);

    // Раньше срока круг опроса ничего не повторяет.
    h.marks.flush();
    await h.tick(0);
    expect(h.sent.length).toBe(RETRY_DELAYS.length + 1);

    await h.tick(SLOW_RETRY_MS);
    h.marks.flush();
    await h.tick(0);
    expect(h.sent.length).toBe(RETRY_DELAYS.length + 2);
    expect(h.marks.pending()).toBe(0);
  });

  it("новое сообщение отменяет неотправленную отметку", async () => {
    const h = harness([new Error("502")]);
    h.marks.mark("d1", "m9");
    await h.tick(0);
    // Пациент написал ещё раз: гасить его сообщение нельзя.
    expect(h.marks.staysRead("d1", "m10")).toBe(false);
    expect(h.marks.pending()).toBe(0);
    h.marks.flush();
    await h.tick(0);
    expect(h.sent.length).toBe(1);
  });

  it("повторное открытие диалога не плодит параллельных записей", async () => {
    const h = harness([new Error("502"), null]);
    h.marks.mark("d1", "m9");
    h.marks.mark("d1", "m9");
    await h.tick(0);
    expect(h.sent).toEqual(["d1"]);
    expect(h.marks.pending()).toBe(1);
  });
});
