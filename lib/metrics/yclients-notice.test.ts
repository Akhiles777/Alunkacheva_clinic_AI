import { describe, expect, it } from "vitest";
import { noticeAboutPromo, noticeMismatch, parseNotice } from "./yclients-notice";

describe("уведомления YCLIENTS как контрольный сигнал", () => {
  it("«Вы записаны на услугу Школьный ресурс 6+…» — запись на услугу акции", () => {
    const n = parseNotice(
      "Вы записаны на услугу Школьный ресурс 6+ к специалисту Ирина Алилгаджиевна на 21 октября 2026 в 10:30.\n\nЖдём вас по адресу: 1-я Магистральная, ул.Гагарина,12 \"а\", 2 эт.",
    );
    expect(n).toMatchObject({ kind: "booked", local: { year: 2026, month: 10, day: 21, hour: 10, minute: 30 } });
    expect(noticeAboutPromo(n!, ["школьн"])).toBe(true);
  });

  it("отмена, изменение, подтверждение и напоминание узнаются; услуга акции — по голове текста", () => {
    expect(parseNotice("Отменена запись. Услуга: Школьный ресурс, специалисту: Ирина Омарова, Время: 21 октября 2026 в 11:30.")?.kind).toBe("cancelled");
    expect(parseNotice("Ваша запись изменена. Вы записаны на Школьный ресурс на 22 октября 2026 в 10:30. Подробнее: https://yc.gl/c/x")?.kind).toBe("changed");
    expect(parseNotice("Запись подтверждена. специалисту: Нурият Абулкасимовна, Услуга: Школьный ресурс, Время: 21 октября 2026 в 12:00.")?.kind).toBe("confirmed");
    const r = parseNotice("Добрый день, Зарема.\nВы записаны к специалисту Ирина Алилгаджиевна на Детский прием до 10 л - остеопатия 21 октября 2026 в 10:30.");
    expect(r?.kind).toBe("reminder");
    expect(noticeAboutPromo(r!, ["школьн"])).toBe(false);
  });

  it("реплика администратора без даты с годом — не уведомление", () => {
    expect(parseNotice("Вы записаны на услугу остеопатии, ждём завтра в 10:30")).toBeNull();
    expect(parseNotice("Добрый день! Подскажите, пожалуйста, адрес")).toBeNull();
  });

  it("расхождение: уведомление о записи без живой записи, отмена при живой записи", () => {
    const booked = parseNotice("Вы записаны на услугу Школьный ресурс 6+ к специалисту Ирина на 21 октября 2026 в 10:30.")!;
    expect(noticeMismatch(booked, [])).toBe("booked-missing");
    expect(noticeMismatch(booked, [{ status: "CANCELLED", deleted: false }])).toBe("booked-missing");
    expect(noticeMismatch(booked, [{ status: "CONFIRMED", deleted: false }])).toBeNull();
    const cancelled = parseNotice("Отменена запись. Услуга: Школьный ресурс, специалисту: Ирина, Время: 21 октября 2026 в 10:30.")!;
    expect(noticeMismatch(cancelled, [{ status: "CONFIRMED", deleted: false }])).toBe("cancelled-alive");
    expect(noticeMismatch(cancelled, [{ status: "CANCELLED", deleted: false }])).toBeNull();
  });
});
