import { describe, expect, it } from "vitest";
import { hasMarker, inFirstDay, waLink } from "./promo-marker";

const at = (s: string) => new Date(`${s}+03:00`);

describe("метка школы", () => {
  it("узнаётся без регистра и пробелов внутри скобок", () => {
    expect(hasMarker("Здравствуйте! Хочу записать ребёнка на школьный ресурс [ШК]", "[ШК]")).toBe(true);
    expect(hasMarker("хочу на ресурс [ шк ]", "[ШК]")).toBe(true);
    expect(hasMarker("хочу на школьный ресурс", "[ШК]")).toBe(false);
    expect(hasMarker("ШК без скобок", "[ШК]")).toBe(false);
    expect(hasMarker("[ШК]", "")).toBe(false);
  });

  it("метка в первом сообщении обращения — засчитывается", () => {
    expect(inFirstDay(at("2026-10-20T10:00:00"), [])).toBe(true);
  });

  it("метка в третьем сообщении в тот же день — засчитывается", () => {
    expect(inFirstDay(at("2026-10-20T15:00:00"), [at("2026-10-20T10:00:00"), at("2026-10-20T10:05:00")])).toBe(true);
  });

  it("метка через двое суток непрерывного разговора — не в первые сутки", () => {
    expect(
      inFirstDay(at("2026-10-22T11:00:00"), [at("2026-10-20T10:00:00"), at("2026-10-21T09:00:00"), at("2026-10-22T08:00:00")]),
    ).toBe(false);
  });

  it("постоянная пациентка: старая переписка месяц назад не мешает — обращение новое", () => {
    expect(inFirstDay(at("2026-10-20T12:00:00"), [at("2026-09-15T10:00:00"), at("2026-10-20T11:00:00")])).toBe(true);
  });

  it("ссылка на WhatsApp — с меткой в тексте; без номера ссылки нет", () => {
    const link = waLink("+7 (928) 516-95-12", "[ШК]");
    expect(link).toMatch(/^https:\/\/wa\.me\/79285169512\?text=/);
    expect(decodeURIComponent(link!.split("text=")[1])).toBe("Здравствуйте! Хочу записать ребёнка на школьный ресурс [ШК]");
    expect(waLink(null, "[ШК]")).toBeNull();
  });
});
