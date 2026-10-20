import { describe, expect, it } from "vitest";
import { DEFAULT_MARKER, hasMarker, inFirstDay, isPreviewBot, markerProbe, waLink } from "./promo-marker";

const at = (s: string) => new Date(`${s}+03:00`);

describe("метка школы", () => {
  it("прежняя метка-значок «[ШК]» узнаётся без регистра и пробелов внутри скобок", () => {
    expect(hasMarker("Здравствуйте! Хочу записать ребёнка на школьный ресурс [ШК]", "[ШК]")).toBe(true);
    expect(hasMarker("хочу на ресурс [ шк ]", "[ШК]")).toBe(true);
    expect(hasMarker("хочу на школьный ресурс", "[ШК]")).toBe(false);
    expect(hasMarker("ШК без скобок", "[ШК]")).toBe(false);
    expect(hasMarker("[ШК]", "")).toBe(false);
  });

  it("метка-фраза «школьный ресурс» — в любом падеже, без регистра и знаков", () => {
    expect(hasMarker("Здравствуйте! Хочу записать ребёнка на школьный ресурс", DEFAULT_MARKER)).toBe(true);
    expect(hasMarker("а можно на ШКОЛЬНЫЙ РЕСУРС 6+?", DEFAULT_MARKER)).toBe(true);
    expect(hasMarker("Интересует запись школьного ресурса", DEFAULT_MARKER)).toBe(true);
    expect(hasMarker("школьный, ресурс", DEFAULT_MARKER)).toBe(true);
    // Слова врозь — не метка; инфузия «Био-Ресурс» — тоже.
    expect(hasMarker("ребёнок школьник, нужен ресурс", DEFAULT_MARKER)).toBe(false);
    expect(hasMarker("Инфузия Био-Ресурс сколько стоит?", DEFAULT_MARKER)).toBe(false);
    expect(hasMarker("ресурс школьный", DEFAULT_MARKER)).toBe(false);
  });

  it("отбор в базе — по самой длинной основе фразы, у значка — по буквам", () => {
    expect(markerProbe(DEFAULT_MARKER)).toBe("школьн");
    expect(markerProbe("[ШК]")).toBe("ШК");
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

  it("ссылка с меткой-фразой: метка уже в тексте и второй раз не дописывается", () => {
    const link = waLink("79285169512", DEFAULT_MARKER);
    expect(decodeURIComponent(link!.split("text=")[1])).toBe("Здравствуйте! Хочу записать ребёнка на школьный ресурс");
  });

  it("превью мессенджеров и роботы — не переход человека", () => {
    expect(isPreviewBot("WhatsApp/2.23.20.0 A")).toBe(true);
    expect(isPreviewBot("TelegramBot (like TwitterBot)")).toBe(true);
    expect(isPreviewBot("facebookexternalhit/1.1")).toBe(true);
    expect(isPreviewBot("")).toBe(true);
    expect(isPreviewBot("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1")).toBe(false);
    expect(isPreviewBot("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36")).toBe(false);
  });

  it("ссылка на WhatsApp — с меткой в тексте; без номера ссылки нет", () => {
    const link = waLink("+7 (928) 516-95-12", "[ШК]");
    expect(link).toMatch(/^https:\/\/wa\.me\/79285169512\?text=/);
    expect(decodeURIComponent(link!.split("text=")[1])).toBe("Здравствуйте! Хочу записать ребёнка на школьный ресурс [ШК]");
    expect(waLink(null, "[ШК]")).toBeNull();
  });
});
