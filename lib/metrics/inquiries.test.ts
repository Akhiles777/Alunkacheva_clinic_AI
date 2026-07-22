import { describe, expect, it } from "vitest";
import { countInquiriesInPeriod, splitIntoInquiries, startsNewInquiry } from "./inquiries";

const at = (iso: string) => new Date(iso);

describe("splitIntoInquiries", () => {
  it("сообщения подряд — одно обращение", () => {
    const windows = splitIntoInquiries([
      at("2026-03-02T09:00:00Z"),
      at("2026-03-02T09:05:00Z"),
      at("2026-03-02T18:00:00Z"),
    ]);

    expect(windows).toHaveLength(1);
    expect(windows[0].messageCount).toBe(3);
    expect(windows[0].startedAt.toISOString()).toBe("2026-03-02T09:00:00.000Z");
    expect(windows[0].lastMessageAt.toISOString()).toBe("2026-03-02T18:00:00.000Z");
  });

  it("разрыв ≥ 24 ч открывает новое обращение", () => {
    const windows = splitIntoInquiries([
      at("2026-03-02T09:00:00Z"),
      at("2026-03-03T09:00:00Z"),
    ]);

    expect(windows).toHaveLength(2);
  });

  it("ровно 24 часа — это уже новое обращение", () => {
    const exact = splitIntoInquiries([at("2026-03-02T09:00:00Z"), at("2026-03-03T09:00:00Z")]);
    expect(exact).toHaveLength(2);

    const justUnder = splitIntoInquiries([
      at("2026-03-02T09:00:00Z"),
      at("2026-03-03T08:59:59Z"),
    ]);
    expect(justUnder).toHaveLength(1);
  });

  it("окно отсчитывается от последнего сообщения, а не от первого", () => {
    // Переписка тянется третьи сутки без пауз — это всё ещё одно обращение.
    const windows = splitIntoInquiries([
      at("2026-03-02T09:00:00Z"),
      at("2026-03-03T08:00:00Z"),
      at("2026-03-04T07:00:00Z"),
    ]);

    expect(windows).toHaveLength(1);
    expect(windows[0].messageCount).toBe(3);
  });

  it("порядок сообщений на входе не важен", () => {
    const windows = splitIntoInquiries([
      at("2026-03-05T09:00:00Z"),
      at("2026-03-02T09:00:00Z"),
      at("2026-03-02T10:00:00Z"),
    ]);

    expect(windows).toHaveLength(2);
    expect(windows[0].messageCount).toBe(2);
  });

  it("пустая переписка обращений не даёт", () => {
    expect(splitIntoInquiries([])).toEqual([]);
  });
});

describe("startsNewInquiry", () => {
  it("первое сообщение всегда открывает обращение", () => {
    expect(startsNewInquiry(null, at("2026-03-02T09:00:00Z"))).toBe(true);
  });

  it("сообщение в течение суток обращение не открывает", () => {
    expect(
      startsNewInquiry(at("2026-03-02T09:00:00Z"), at("2026-03-02T20:00:00Z")),
    ).toBe(false);
  });

  it("после суток молчания — новое обращение", () => {
    expect(
      startsNewInquiry(at("2026-03-02T09:00:00Z"), at("2026-03-04T09:00:00Z")),
    ).toBe(true);
  });
});

describe("countInquiriesInPeriod", () => {
  it("считает по дате начала обращения, границы — [from, to)", () => {
    const windows = splitIntoInquiries([
      at("2026-02-28T09:00:00Z"),
      at("2026-03-01T09:00:00Z"),
      at("2026-03-15T09:00:00Z"),
      at("2026-04-01T09:00:00Z"),
    ]);

    const count = countInquiriesInPeriod(
      windows,
      at("2026-03-01T00:00:00Z"),
      at("2026-04-01T00:00:00Z"),
    );

    expect(count).toBe(2);
  });
});
