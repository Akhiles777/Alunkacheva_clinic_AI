import { describe, expect, it } from "vitest";
import { checkFile, kindOfFile, humanSize, willSplit } from "./limits";

describe("что можно отправить пациенту", () => {
  it("вид файла берётся из типа, а не из расширения", () => {
    expect(kindOfFile("image/jpeg", "скан.pdf")).toBe("photo");
    expect(kindOfFile("application/pdf", "прайс.pdf")).toBe("document");
    expect(kindOfFile("audio/ogg; codecs=opus")).toBe("audio");
  });

  it("пустой тип — решает расширение (так отдаёт файлы Safari)", () => {
    expect(kindOfFile("", "снимок.HEIC")).toBe("photo");
    expect(kindOfFile(null, "запись.m4a")).toBe("audio");
    expect(kindOfFile(undefined, "договор")).toBe("document");
  });

  it("большая фотография в WhatsApp отклоняется с названным пределом", () => {
    const r = checkFile({ channel: "WHATSAPP", mimeType: "image/jpeg", sizeBytes: 9 * 1024 * 1024 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("5 МБ");
    expect(r.reason).toContain("9 МБ");
  });

  it("та же фотография в Telegram проходит: у него предел выше", () => {
    expect(checkFile({ channel: "TELEGRAM", mimeType: "image/jpeg", sizeBytes: 9 * 1024 * 1024 }).ok).toBe(true);
  });

  it("в Instagram файлы не отправляем и говорим об этом словами", () => {
    const r = checkFile({ channel: "INSTAGRAM", mimeType: "image/jpeg", sizeBytes: 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Instagram");
  });

  it("пустой файл не отправляется", () => {
    expect(checkFile({ channel: "WHATSAPP", mimeType: "image/jpeg", sizeBytes: 0 }).ok).toBe(false);
  });

  it("размер называется по-человечески", () => {
    expect(humanSize(5 * 1024 * 1024)).toBe("5 МБ");
    expect(humanSize(1536 * 1024)).toBe("1,5 МБ");
    expect(humanSize(2048)).toBe("2 КБ");
  });

  it("длинный текст считается сообщениями", () => {
    expect(willSplit("а".repeat(100))).toBe(1);
    expect(willSplit("а".repeat(4001))).toBe(2);
  });
});
