import { describe, expect, it } from "vitest";
import { intentFrom, maskPhones, parseUnderstood } from "./admin-understand";

const known = {
  staff: [{ id: "s1", name: "Ирина Омарова" }],
  services: [{ id: "v1", title: "БОС-терапия" }],
};
const now = new Date("2026-10-15T09:00:00Z");
const sendAt = () => null;

describe("телефон из вопроса модели не уходит", () => {
  it.each([
    ["Предупреди Сумаю(79886816931) что нужно подтвердить", "9886816931"],
    ["Напиши Сумая- 79286816931 чтобы не забывала", "9286816931"],
    ["+7 (900) 712-09-05", "9007120905"],
    ["89007120905", "9007120905"],
  ])("«%s»", (q, digits) => {
    const m = maskPhones(q);
    expect(m.phones).toEqual([digits]);
    expect(m.text).not.toMatch(/\d{5,}/);
    expect(m.text).toContain("[ТЕЛЕФОН]");
  });

  it("время и сумма — не телефон", () => {
    expect(maskPhones("в 14:30 на 5000 ₽").phones).toEqual([]);
  });
});

describe("ответ модели", () => {
  it("JSON внутри текста разбирается, мусор — нет", () => {
    expect(parseUnderstood('Вот: {"action":"schedule","date":"tomorrow"}')).toMatchObject({ action: "schedule" });
    expect(parseUnderstood("не знаю")).toBeNull();
    expect(parseUnderstood('{"action":"отправить_сразу"}')).toBeNull();
  });

  it("у модели нет действия «отправить» — только подготовить письмо", () => {
    expect(parseUnderstood('{"action":"send"}')).toBeNull();
    const u = parseUnderstood('{"action":"message_one","patient_name":"Сумая","message_text":"Здравствуйте!"}')!;
    expect(intentFrom(u, known, now, sendAt)).toMatchObject({ kind: "message_one", name: "Сумая", text: "Здравствуйте!" });
  });

  it("«кто завтра на БОС» — список записанных с услугой", () => {
    const u = parseUnderstood('{"action":"schedule","date":"tomorrow","service":"БОС терапия"}')!;
    expect(intentFrom(u, known, now, sendAt)).toMatchObject({ kind: "schedule", serviceId: "v1", date: { offset: 1 } });
  });

  it("врач и услуга, которых нет у клиники, условием не становятся", () => {
    const u = parseUnderstood('{"action":"schedule","staff":"Петров","service":"МРТ"}')!;
    expect(intentFrom(u, known, now, sendAt)).toMatchObject({ staffId: null, serviceId: null });
  });

  it("рассылка без условия — audience none", () => {
    const u = parseUnderstood('{"action":"broadcast","message_text":"Клиника завтра не работает"}')!;
    expect(intentFrom(u, known, now, sendAt)).toMatchObject({ kind: "broadcast", audience: "none" });
  });
});
