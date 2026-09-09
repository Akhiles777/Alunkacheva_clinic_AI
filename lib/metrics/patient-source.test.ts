import { describe, expect, it } from "vitest";
import { firstContactSource, type ContactTouch } from "./patient-source";

const wa = (at: string): ContactTouch => ({ at: new Date(at), sourceId: "s-wa", kind: "message" });
const call = (at: string): ContactTouch => ({ at: new Date(at), sourceId: "s-call", kind: "call" });

describe("источник первого обращения", () => {
  it("берёт самое раннее касание", () => {
    const r = firstContactSource({
      current: { sourceId: null, confidence: "UNKNOWN" },
      touches: [wa("2026-03-02T10:00:00Z"), call("2026-01-05T09:00:00Z")],
    });
    expect(r.sourceId).toBe("s-call");
    expect(r.confidence).toBe("DERIVED");
    expect(r.changed).toBe(true);
    expect(r.basis?.kind).toBe("call");
  });

  it("касаний нет — источник остаётся неизвестным, звонок не подставляется", () => {
    const r = firstContactSource({ current: { sourceId: null, confidence: "UNKNOWN" }, touches: [] });
    expect(r.sourceId).toBeNull();
    expect(r.changed).toBe(false);
  });

  it("ручную отметку не трогает никогда", () => {
    const r = firstContactSource({
      current: { sourceId: "s-instagram", confidence: "MANUAL" },
      touches: [wa("2026-03-02T10:00:00Z")],
    });
    expect(r.sourceId).toBe("s-instagram");
    expect(r.confidence).toBe("MANUAL");
    expect(r.changed).toBe(false);
  });

  it("уже выведенный источник не переписывается", () => {
    const r = firstContactSource({
      current: { sourceId: "s-instagram", confidence: "DERIVED" },
      touches: [wa("2026-03-02T10:00:00Z")],
    });
    expect(r.sourceId).toBe("s-instagram");
    expect(r.changed).toBe(false);
  });

  it("повторный расчёт на тех же данных ничего не меняет", () => {
    const touches = [wa("2026-03-02T10:00:00Z"), call("2026-01-05T09:00:00Z")];
    const once = firstContactSource({ current: { sourceId: null, confidence: "UNKNOWN" }, touches });
    const twice = firstContactSource({
      current: { sourceId: once.sourceId, confidence: once.confidence },
      touches,
    });
    expect(twice.changed).toBe(false);
    expect(twice.sourceId).toBe(once.sourceId);
  });

  it("при равном времени выбор не зависит от порядка строк", () => {
    const a: ContactTouch = { at: new Date("2026-01-05T09:00:00Z"), sourceId: "s-b", kind: "message" };
    const b: ContactTouch = { at: new Date("2026-01-05T09:00:00Z"), sourceId: "s-a", kind: "call" };
    const one = firstContactSource({ current: { sourceId: null, confidence: "UNKNOWN" }, touches: [a, b] });
    const two = firstContactSource({ current: { sourceId: null, confidence: "UNKNOWN" }, touches: [b, a] });
    expect(one.sourceId).toBe(two.sourceId);
  });
});
