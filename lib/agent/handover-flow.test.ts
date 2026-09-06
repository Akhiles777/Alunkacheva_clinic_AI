import { describe, expect, it } from "vitest";
import { inHandoverFlow, timeDetail } from "./handover-flow";

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
