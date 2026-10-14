import { describe, expect, it } from "vitest";
import { scheduleChangeOf } from "./urgent";

const IN = (body: string) => ({ direction: "IN" as const, body });
const OUT = (body: string) => ({ direction: "OUT" as const, body });

describe("scheduleChangeOf", () => {
  it("отмена в неотвеченных — срочно", () => {
    expect(scheduleChangeOf([OUT("Ждём вас"), IN("Завтра не сможем прийти, ребёнок заболел")])).toBe("cancel");
    expect(scheduleChangeOf([IN("Можете запись на вторник отменить")])).toBe("cancel");
  });
  it("перенос", () => {
    expect(scheduleChangeOf([IN("Можно перенести на другой день?")])).toBe("move");
  });
  it("на отмену уже ответили — не срочно", () => {
    expect(scheduleChangeOf([IN("Отмените запись"), OUT("Отменила, выздоравливайте")])).toBeNull();
  });
  it("вопрос об условиях отмены — не отмена", () => {
    expect(scheduleChangeOf([IN("За сколько дней можно бесплатно отменить?")])).toBeNull();
  });
  it("обычный вопрос", () => {
    expect(scheduleChangeOf([IN("Сколько стоит приём?")])).toBeNull();
  });
});
