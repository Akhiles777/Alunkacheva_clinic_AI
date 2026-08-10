import { describe, expect, it } from "vitest";
import { promisesBooking } from "./booking-promise";

/**
 * §6: расписанием агент не распоряжается. Проверка появилась после боевого
 * случая — ассистент сказал пациенту, что сам его запишет и ведёт запись.
 */
describe("promisesBooking", () => {
  it("ловит обещание записать", () => {
    expect(promisesBooking("Хорошо, запишу вас на завтра в 15:00")).toBe(true);
    expect(promisesBooking("Записываю вас к остеопату")).toBe(true);
    expect(promisesBooking("Я забронирую для вас это время")).toBe(true);
    expect(promisesBooking("Поставлю вас на 14:00")).toBe(true);
    expect(promisesBooking("Подберу вам удобное время")).toBe(true);
    expect(promisesBooking("Оформлю запись прямо сейчас")).toBe(true);
  });

  it("ловит подтверждение брони", () => {
    expect(promisesBooking("Готово, вы записаны на пятницу")).toBe(true);
    expect(promisesBooking("Запись создана, ждём вас")).toBe(true);
    expect(promisesBooking("Ждём вас 15:00 в кабинете 3")).toBe(true);
  });

  it("не мешает правильным ответам про запись", () => {
    expect(promisesBooking("Запись ведёт администратор — передал ему ваш вопрос.")).toBe(false);
    expect(
      promisesBooking("Записью занимается администратор, он свяжется с вами здесь."),
    ).toBe(false);
    expect(promisesBooking("Приём остеопата стоит 7000 ₽ и длится 60 минут.")).toBe(false);
    expect(promisesBooking("Наш адрес: Островского 20а, 2 этаж.")).toBe(false);
  });
});
