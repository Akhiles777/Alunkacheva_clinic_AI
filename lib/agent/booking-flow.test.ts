import { describe, expect, it } from "vitest";
import { bookingStep, complaintAsReason, dataAlreadyReceived, staffConfirmedBooking, type BookingState } from "./booking-flow";

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

describe("жалоба посреди записи — причина, а не медицинский вопрос", () => {
  it("ответ на наш вопрос и просьба записать с жалобой — причина записи", () => {
    for (const t of [
      "Ребенок, новорожденный, 12 дней. Выгибание шеи когда лежит",
      "Взрослый, болит шея после сна",
      "Хочу записаться к остеопату, болит спина",
      "Хочу записать сына 5 лет к остеопату, жалобы на осанку",
    ]) {
      expect(complaintAsReason(t, true), t).toBe(true);
    }
  });

  it("вне разговора о записи правило не действует", () => {
    expect(complaintAsReason("Болит шея после сна", false)).toBe(false);
  });

  it("вопрос — знаком или словами — остаётся медицинским", () => {
    for (const t of [
      "Болит спина, остеопат поможет?",
      "Болит спина, можно ли к остеопату",
      "у сына сколиоз, остеопатия поможет",
      "ребёнку 2 недели можно",
      "не знаю что делать, болит голова каждый день",
    ]) {
      expect(complaintAsReason(t, true), t).toBe(false);
    }
  });

  it("срочное зовёт человека как медицинское", () => {
    for (const t of [
      "Хочу записать сына, у него температура 39",
      "Ребенок упал, ударился головой, хотим к остеопату",
      "у малыша судороги, запишите пожалуйста",
    ]) {
      expect(complaintAsReason(t, true), t).toBe(false);
    }
  });
});

describe("данные для записи уже присланы", () => {
  const talk = (...turns: [("user" | "assistant"), string][]) => turns.map(([role, content]) => ({ role, content }));

  it("живой диалог 5 октября: после «передал(а) ваши данные» просьба о времени не просит их снова", () => {
    const history = talk(
      ["user", "Мне сначала на БОС записаться или к остеопату ?"],
      ["assistant", "Время подберёт администратор. Пришлите, пожалуйста, одним сообщением: ФИО, возраст, вес и кратко причину обращения."],
      ["user", "Султанова Джамиля 13 лет.  35 кг . Энурез."],
      ["assistant", "Спасибо, передал(а) ваши данные администратору. Он подберёт ближайшее удобное время и напишет здесь же."],
    );
    expect(dataAlreadyReceived(history, "Если можно запишите с утра на 9 часов в ближайший свободный день")).toBe(true);
    expect(dataAlreadyReceived(history, "А лучше к Разият")).toBe(true);
  });

  it("второй человек — данных нет", () => {
    const history = talk(["assistant", "Данные передал(а) администратору — он подберёт время и напишет здесь же."]);
    expect(dataAlreadyReceived(history, "А можно ещё сына записать?")).toBe(false);
    expect(dataAlreadyReceived(history, "И дочку тоже запишите")).toBe(false);
  });

  it("просьба о данных после приёма или новая запись — данных для неё нет", () => {
    expect(
      dataAlreadyReceived(
        talk(
          ["assistant", "Спасибо, передал(а) ваши данные администратору."],
          ["user", "Хочу записаться к остеопату"],
          ["assistant", "К кому хотите записаться?"],
        ),
        "К Разият",
      ),
    ).toBe(false);
    expect(
      dataAlreadyReceived(
        talk(["assistant", "Пришлите, пожалуйста, одним сообщением: ФИО, возраст и кратко причину обращения."]),
        "в 9 утра",
      ),
    ).toBe(false);
  });

  it("данных не присылали — нет", () => {
    expect(dataAlreadyReceived(talk(["assistant", "Здравствуйте! Чем могу помочь?"]), "Хочу записаться")).toBe(false);
  });
});

describe("диагноз как причина записи", () => {
  it("просят записать, спрашивают цену и день — это запись, а не вопрос о лечении", () => {
    const t = "Здравствуйте, у дочки 7 лет сколиоз, хотим к остеопату, сколько стоит и можно ли на субботу?";
    expect(complaintAsReason(t, true, true)).toBe(true);
    expect(complaintAsReason(t, true, false)).toBe(false);
  });
  it("вопрос о самом диагнозе остаётся медицинским", () => {
    for (const t of ["У сына сколиоз, хотим к остеопату, поможет ли?", "У дочки ДЦП, можно ли ей остеопатию?"]) {
      expect(complaintAsReason(t, true, true), t).toBe(false);
    }
  });
});
