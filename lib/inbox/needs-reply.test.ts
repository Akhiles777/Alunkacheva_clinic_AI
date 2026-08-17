import { describe, expect, it } from "vitest";
import { isNewInquiryWaiting, type InboxMessage } from "./needs-reply";

const T0 = new Date("2026-08-17T09:00:00Z").getTime();
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);
const msg = (direction: "IN" | "OUT", minutes: number): InboxMessage => ({
  direction,
  createdAt: at(minutes),
});
const DAY = 24 * 60;

describe("метка «нужен ответ»", () => {
  it("совсем новый диалог — обращение", () => {
    expect(isNewInquiryWaiting([msg("IN", 0)])).toBe(true);
  });

  it("«спасибо» после разговора — не обращение", () => {
    // Ровно то, из-за чего метку и сузили: список наполнялся тем, на что
    // отвечать не нужно.
    expect(isNewInquiryWaiting([msg("IN", 0), msg("OUT", 1), msg("IN", 3)])).toBe(false);
  });

  it("написал через сутки после прошлого разговора — обращение", () => {
    expect(isNewInquiryWaiting([msg("IN", 0), msg("OUT", 1), msg("IN", DAY + 5)])).toBe(true);
  });

  it("два сообщения подряд не снимают метку", () => {
    // «Здравствуйте», а через минуту «хочу записаться». Промежуток меряем у
    // первого неотвеченного, иначе пациент вторым сообщением сам гасит метку.
    const messages = [
      msg("IN", 0),
      msg("OUT", 1),
      msg("IN", DAY + 5),
      msg("IN", DAY + 6),
      msg("IN", DAY + 8),
    ];
    expect(isNewInquiryWaiting(messages)).toBe(true);
  });

  it("продолжение разговора несколькими сообщениями — по-прежнему не обращение", () => {
    const messages = [msg("IN", 0), msg("OUT", 1), msg("IN", 3), msg("IN", 4)];
    expect(isNewInquiryWaiting(messages)).toBe(false);
  });

  it("последним ответили мы — метки нет", () => {
    expect(isNewInquiryWaiting([msg("IN", 0), msg("OUT", 1)])).toBe(false);
  });

  it("пустая переписка ничего не ломает", () => {
    expect(isNewInquiryWaiting([])).toBe(false);
  });

  it("диалог начался с нашего сообщения, пациент ответил сразу — не обращение", () => {
    // Клиника написала первой (напоминание о визите) — ответ на него разговор
    // продолжает, а не начинает.
    expect(isNewInquiryWaiting([msg("OUT", 0), msg("IN", 5)])).toBe(false);
  });
});
