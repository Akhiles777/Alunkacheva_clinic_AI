import { describe, expect, it } from "vitest";
import { asClient, asRecord, eventId } from "./webhook-process";

/**
 * Вебхуки раньше принимались и выбрасывались: изменения из YCLIENTS до нас не
 * доезжали, хотя он — источник истины по расписанию (§2).
 */
const recordEvent = {
  resource: "record",
  resource_id: 77,
  status: "update" as const,
  data: { id: 77, staff_id: 5, datetime: "2026-08-10T10:00:00+03:00" },
};

describe("eventId", () => {
  it("повтор той же доставки даёт тот же идентификатор", () => {
    expect(eventId(recordEvent)).toBe(eventId({ ...recordEvent }));
  });

  it("другое содержимое даёт другой идентификатор", () => {
    const changed = { ...recordEvent, data: { ...recordEvent.data, datetime: "2026-08-11T10:00:00+03:00" } };
    expect(eventId(changed)).not.toBe(eventId(recordEvent));
  });

  it("разные сущности с одним номером не сливаются", () => {
    expect(eventId({ resource: "record", resource_id: 1 })).not.toBe(
      eventId({ resource: "client", resource_id: 1 }),
    );
  });
});

describe("разбор тела события", () => {
  it("принимает запись с обязательными полями", () => {
    expect(asRecord(recordEvent)?.id).toBe(77);
  });

  it("отвергает запись без специалиста или времени", () => {
    expect(asRecord({ resource: "record", data: { id: 1, datetime: "2026-08-10T10:00:00Z" } })).toBeNull();
    expect(asRecord({ resource: "record", data: { id: 1, staff_id: 5 } })).toBeNull();
    expect(asRecord({ resource: "record" })).toBeNull();
  });

  it("принимает клиента без телефона: он может быть скрыт настройками", () => {
    expect(asClient({ resource: "client", data: { id: 42 } })?.id).toBe(42);
    expect(asClient({ resource: "client", data: {} })).toBeNull();
  });
});
