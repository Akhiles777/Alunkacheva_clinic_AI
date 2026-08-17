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

/**
 * Правило 24 часов теперь считается ещё и в базе — тем же смыслом, что в
 * splitIntoInquiries. Проверяем, что оба пути дают одно число: если они
 * разойдутся, в отчёте и в инбоксе будут разные обращения.
 */
describe("правило одно для памяти и для базы", () => {
  it("splitIntoInquiries режет поток так же, как ожидает SQL", () => {
    const times = [
      new Date("2026-08-01T10:00:00Z"),
      new Date("2026-08-01T10:30:00Z"),
      new Date("2026-08-02T12:00:00Z"),
      new Date("2026-08-09T09:00:00Z"),
    ];
    // Разрывы: 30 мин (то же обращение), 25.5 ч (новое), неделя (новое).
    expect(splitIntoInquiries(times)).toHaveLength(3);
  });

  it("сутки считаются от предыдущего сообщения, а не от первого", () => {
    // Человек писал в 10:00 и в 22:00, потом в 10:00 следующего дня. От
    // первого сообщения прошли сутки, но разговор не прерывался.
    const times = [
      new Date("2026-08-01T10:00:00Z"),
      new Date("2026-08-01T22:00:00Z"),
      new Date("2026-08-02T10:00:00Z"),
    ];
    expect(splitIntoInquiries(times)).toHaveLength(1);
  });
});
