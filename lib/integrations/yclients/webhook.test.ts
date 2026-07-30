import { afterEach, describe, expect, it } from "vitest";
import { entityForResource, parseWebhook, verifyWebhookSecret } from "./webhook";

describe("parseWebhook", () => {
  it("парсит одиночное событие", () => {
    const events = parseWebhook({ resource: "record", resource_id: 42, status: "update" });
    expect(events).toHaveLength(1);
    expect(events[0].resource).toBe("record");
  });
  it("парсит массив и отбрасывает мусор", () => {
    const events = parseWebhook([
      { resource: "client", status: "create" },
      { nonsense: true },
      { resource: "record", status: "delete" },
    ]);
    expect(events.map((e) => e.resource)).toEqual(["client", "record"]);
  });
  it("невалидный статус отбрасывается", () => {
    expect(parseWebhook({ resource: "record", status: "frobnicate" })).toHaveLength(0);
  });
});

describe("verifyWebhookSecret", () => {
  afterEach(() => {
    delete process.env.YCLIENTS_WEBHOOK_SECRET;
  });
  it("пустой секрет в окружении → всегда закрыто", () => {
    expect(verifyWebhookSecret("anything")).toBe(false);
  });
  it("совпадение → true, расхождение → false", () => {
    process.env.YCLIENTS_WEBHOOK_SECRET = "s3cr3t-token";
    expect(verifyWebhookSecret("s3cr3t-token")).toBe(true);
    expect(verifyWebhookSecret("wrong")).toBe(false);
    expect(verifyWebhookSecret(null)).toBe(false);
  });
});

describe("entityForResource", () => {
  it("маппит ресурс на сущность синка", () => {
    expect(entityForResource("record")).toBe("RECORDS");
    expect(entityForResource("client")).toBe("CLIENTS");
    expect(entityForResource("unknown")).toBeNull();
  });
});
