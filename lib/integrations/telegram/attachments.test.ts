import { describe, expect, it } from "vitest";
import { attachmentsFrom } from "./attachments";
import { messageBody, needsHuman } from "@/lib/agent/attachments";

describe("вложения Telegram", () => {
  it("голосовое распознаётся и не теряется", () => {
    // Главный случай. Раньше сообщение без текста выпадало целиком: не
    // сохранялось, в инбоксе не появлялось, уведомление не приходило.
    const a = attachmentsFrom({ voice: { file_id: "AwACAgIx", duration: 7, mime_type: "audio/ogg" } });
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("voice");
    expect(a[0].source).toEqual({ provider: "TELEGRAM", fileId: "AwACAgIx" });
    expect(a[0].durationSec).toBe(7);
  });

  it("из размеров фотографии берётся самый крупный", () => {
    // На уменьшенной копии не прочитать направление или анализы.
    const a = attachmentsFrom({
      photo: [
        { file_id: "small", file_size: 1000 },
        { file_id: "big", file_size: 90000 },
      ],
    });
    expect(a[0].source).toEqual({ provider: "TELEGRAM", fileId: "big" });
  });

  it("кружок считается видео", () => {
    const a = attachmentsFrom({ video_note: { file_id: "note1", duration: 12 } });
    expect(a[0].kind).toBe("video");
  });

  it("документ сохраняет имя файла", () => {
    const a = attachmentsFrom({
      document: { file_id: "doc1", file_name: "анализы.pdf", mime_type: "application/pdf" },
    });
    expect(a[0].fileName).toBe("анализы.pdf");
  });

  it("у геопозиции файла нет, но подпись есть", () => {
    const a = attachmentsFrom({ location: { latitude: 42.98, longitude: 47.5 } });
    expect(a[0].source).toEqual({ provider: "NONE" });
    expect(a[0].label).toContain("42.98");
  });

  it("обычный текст вложений не даёт", () => {
    expect(attachmentsFrom({})).toEqual([]);
    expect(attachmentsFrom(undefined)).toEqual([]);
  });

  it("несколько полей разбираются вместе", () => {
    const a = attachmentsFrom({
      photo: [{ file_id: "p" }],
      document: { file_id: "d" },
    });
    expect(a.map((x) => x.kind)).toEqual(["photo", "document"]);
  });
});

describe("тело сообщения с вложением", () => {
  it("подпись пациента сохраняется рядом с пометкой", () => {
    const a = attachmentsFrom({ photo: [{ file_id: "p" }] });
    expect(messageBody("вот направление", a)).toBe("[фотография] вот направление");
  });

  it("без подписи остаётся одна пометка, а не пустая строка", () => {
    const a = attachmentsFrom({ voice: { file_id: "v" } });
    expect(messageBody("", a)).toBe("[голосовое сообщение]");
  });

  it("без вложений ведёт себя как обычный текст", () => {
    expect(messageBody("здравствуйте", [])).toBe("здравствуйте");
    expect(messageBody("  ", [])).toBe("");
  });
});

describe("кого зовём на вложение", () => {
  it("голосовое и фото уходят человеку: ассистент их не читает", () => {
    expect(needsHuman(attachmentsFrom({ voice: { file_id: "v" } }))).toBe(true);
    expect(needsHuman(attachmentsFrom({ photo: [{ file_id: "p" }] }))).toBe(true);
  });

  it("стикер человека не требует", () => {
    // Стикер — не обращение, дёргать администратора незачем.
    expect(needsHuman(attachmentsFrom({ sticker: { file_id: "s", emoji: "👍" } }))).toBe(false);
  });
});
