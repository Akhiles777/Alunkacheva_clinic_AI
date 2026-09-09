import { describe, expect, it } from "vitest";
import { deliveryPatch, stageOf } from "./delivery";

const at = new Date("2026-09-09T10:00:00Z");
const fresh = { status: "SENT", sentAt: null, deliveredAt: null, readAt: null };

describe("состояние доставки", () => {
  it("разбирает слова провайдера", () => {
    expect(stageOf("READ")).toBe("read");
    expect(stageOf("noAccount")).toBe("failed");
    expect(stageOf("что-то новое")).toBeNull();
  });

  it("идёт только вперёд: доставлено не отменяет прочитано", () => {
    const read = { status: "SENT", sentAt: at, deliveredAt: at, readAt: at };
    expect(deliveryPatch(read, "delivered", new Date())).toBeNull();
    expect(deliveryPatch(read, "sent", new Date())).toBeNull();
  });

  it("прочитано проставляет и доставку: события приходят вразнобой", () => {
    const p = deliveryPatch(fresh, "read", at);
    expect(p?.readAt).toEqual(at);
    expect(p?.deliveredAt).toEqual(at);
    expect(p?.sentAt).toEqual(at);
  });

  it("провайдер сказал «не доставлено» — записываем причину словами", () => {
    const p = deliveryPatch({ ...fresh, sentAt: at }, "failed", at);
    expect(p?.status).toBe("FAILED");
    expect(p?.failureReason).toContain("не доставлено");
  });

  it("сообщение, помеченное неудачей, но прочитанное пациентом — правда за провайдером", () => {
    const failed = { status: "FAILED", sentAt: null, deliveredAt: null, readAt: null };
    const p = deliveryPatch(failed, "read", at);
    expect(p?.status).toBe("SENT");
    expect(p?.readAt).toEqual(at);
  });

  it("повторное «доставлено» ничего не меняет", () => {
    const delivered = { status: "SENT", sentAt: at, deliveredAt: at, readAt: null };
    expect(deliveryPatch(delivered, "delivered", new Date())).toBeNull();
  });
});
