import { describe, expect, it } from "vitest";
import { bookingStep, staffConfirmedBooking, type BookingState } from "./booking-flow";

const base: BookingState = {
  booking: true,
  service: false,
  whom: false,
  whomMatters: true,
  doctorMatters: true,
  doctor: false,
  dataDone: false,
  refused: false,
  askedByModel: {},
};

describe("порядок разговора о записи", () => {
  it("идёт по шагам: услуга → для кого → врач → данные", () => {
    expect(bookingStep(base).step).toBe("service");
    expect(bookingStep({ ...base, service: true }).step).toBe("whom");
    expect(bookingStep({ ...base, service: true, whom: true }).step).toBe("doctor");
    expect(bookingStep({ ...base, service: true, whom: true, doctor: true }).step).toBe("data");
    expect(
      bookingStep({ ...base, service: true, whom: true, doctor: true, dataDone: true }).step,
    ).toBeNull();
  });

  it("врачи из разговора не исчезают: шаг выбора не перескакивается", () => {
    // Живая жалоба: «а где сами врачи в этом диалоге?» — после «для ребёнка»
    // агент называл цену и сразу просил данные.
    const afterWhom = bookingStep({ ...base, service: true, whom: true });
    expect(afterWhom).toEqual({ step: "doctor", ask: true });
  });

  it("нечего выбирать — шаг пропускается", () => {
    // Услуга в одном варианте: спрашивать «взрослый или ребёнок» незачем.
    expect(bookingStep({ ...base, service: true, whomMatters: false }).step).toBe("doctor");
    // Услугу ведёт один специалист — выбора нет.
    expect(
      bookingStep({ ...base, service: true, whom: true, doctorMatters: false }).step,
    ).toBe("data");
  });

  it("модель уже спросила — второй раз не спрашиваем, но шаг тот же", () => {
    const s = bookingStep({ ...base, service: true, askedByModel: { whom: true } });
    expect(s).toEqual({ step: "whom", ask: false });
  });

  it("отказ в услуге и разговор не о записи шагов не имеют", () => {
    expect(bookingStep({ ...base, refused: true }).step).toBeNull();
    expect(bookingStep({ ...base, booking: false }).step).toBeNull();
  });
});

describe("какая реплика сотрудника закрывает просьбу записать", () => {
  it("«Записала», «Вы записаны на…» — запись оформлена", () => {
    expect(staffConfirmedBooking("Записала")).toBe(true);
    expect(
      staffConfirmedBooking("Вы записаны на услугу Лотос к специалисту Нурият Абулкасимовна на 1 октября 2026 в 13:30."),
    ).toBe(true);
    expect(staffConfirmedBooking("Записали вас на завтра")).toBe(true);
  });

  it("приветствие, вопрос и эхо ответа агента запись не оформляют", () => {
    for (const t of [
      "Добрый день",
      "Таня, завтра удобно будет на 13:30, если я запишу на лотос?",
      "Записывает администратор — он подберёт время и напишет здесь же.",
      "К кому хотите записаться — Ирина Алилгаджиевна или Разият Ризвановна?",
      "Ближайшая запись к доктору - 7 октября в 11:00",
    ]) {
      expect(staffConfirmedBooking(t), t).toBe(false);
    }
  });
});
