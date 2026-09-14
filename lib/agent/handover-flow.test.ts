import { describe, expect, it } from "vitest";
import { inHandoverFlow, rescheduleAsked, timeDetail } from "./handover-flow";

const turn = (role: "user" | "assistant", content: string) => ({ role, content });

describe("inHandoverFlow", () => {
  it("последняя реплика агента — передача администратору", () => {
    expect(
      inHandoverFlow([
        turn("user", "Можете перенести нашу запись"),
        turn("assistant", "Поняла, передал(а) администратору — он подберёт время и напишет здесь же."),
      ]),
    ).toBe(true);
  });

  it("обычный ответ передачей не считается", () => {
    expect(
      inHandoverFlow([
        turn("user", "Сколько стоит остеопатия?"),
        turn("assistant", "Взрослый приём — остеопатия, 8 000 ₽, 60 мин."),
      ]),
    ).toBe(false);
  });

  it("смотрим на последнюю реплику агента, а не на любую", () => {
    expect(
      inHandoverFlow([
        turn("assistant", "Передал(а) администратору — он ответит здесь же."),
        turn("user", "А сколько стоит приём?"),
        turn("assistant", "Взрослый приём — 8 000 ₽."),
      ]),
    ).toBe(false);
  });

  it("пустая история — не передача", () => {
    expect(inHandoverFlow([])).toBe(false);
  });
});

describe("timeDetail", () => {
  it("узнаёт время и дни", () => {
    for (const t of [
      "В 9:00 у нас реабилитация",
      "после 12 удобно",
      "давайте 8 сентября",
      "завтра не сможем",
      "в среду мы заняты",
      "утром будет удобно",
    ]) {
      expect(timeDetail(t), t).toBe(true);
    }
  });

  it("справочный вопрос уточнением по времени не считается", () => {
    for (const t of ["Сколько стоит приём остеопата", "Где вы находитесь", "У вас есть парковка"]) {
      expect(timeDetail(t), t).toBe(false);
    }
  });
});

describe("rescheduleAsked", () => {
  it("уточнение после просьбы перенести — часть переноса (живой диалог 14 сентября)", () => {
    expect(
      rescheduleAsked([
        turn(
          "user",
          "Здравствуй\nЯ извиняюсь, ребенок начал температурить вчера вечером, 8 месяцев ему\n\nНе будет возможности перенести запись через неделю или когда есть у вас окошко",
        ),
        turn("assistant", "Поняла, передал(а) администратору — он подберёт время и напишет здесь же."),
        turn("user", "На остеопатию были записаны к Ирине Алигаджиевне"),
      ]),
    ).toBe(true);
  });

  it("без просьбы о переносе — обычное упоминание записи", () => {
    expect(
      rescheduleAsked([
        turn("user", "Сколько стоит остеопатия?"),
        turn("assistant", "Детский приём — 6 000 ₽."),
        turn("user", "Записана на 8 сентября"),
      ]),
    ).toBe(false);
  });

  it("старая просьба давно позади — не тянем её в новый разговор", () => {
    expect(
      rescheduleAsked([
        turn("user", "Можно перенести запись?"),
        turn("user", "Спасибо"),
        turn("user", "А сколько стоит БОС?"),
        turn("user", "Хорошо"),
        turn("user", "Записана на 20 сентября"),
      ]),
    ).toBe(false);
  });
});
