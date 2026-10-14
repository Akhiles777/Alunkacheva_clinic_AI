import { describe, expect, it } from "vitest";
import { codeFromTitle, fillTemplate, missingLabel, templateVariables } from "./message-template";

/**
 * Подстановки не было вовсе: кнопка шаблона отправляла пациенту «Здравствуйте,
 * {{name}}!». Один такой ответ дороже десяти неотправленных.
 */
describe("подстановка переменных", () => {
  const body = "Здравствуйте, {{name}}! Напоминаем о визите {{date}} в {{time}}.";

  it("находит переменные", () => {
    expect(templateVariables(body)).toEqual(["name", "date", "time"]);
  });

  it("подставляет значения", () => {
    const res = fillTemplate(body, { name: "Гульбара", date: "8 сентября", time: "09:00" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toBe("Здравствуйте, Гульбара! Напоминаем о визите 8 сентября в 09:00.");
      expect(res.text).not.toContain("{{");
    }
  });

  it("не отправляет шаблон с незаполненной переменной", () => {
    const res = fillTemplate(body, { name: "Гульбара", date: "", time: null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.missing).toEqual(["date", "time"]);
  });

  it("шаблон без переменных заполняется всегда", () => {
    const res = fillTemplate("Спасибо за обращение!", {});
    expect(res.ok).toBe(true);
  });

  it("называет недостающее человеческими словами", () => {
    expect(missingLabel(["date", "time"])).toBe(
      "дата ближайшей записи, время ближайшей записи",
    );
  });
});

describe("код шаблона", () => {
  it("делается из названия латиницей", () => {
    expect(codeFromTitle("Напоминание о визите")).toBe("napominanie_o_vizite");
  });

  it("не повторяет занятый код", () => {
    expect(codeFromTitle("Напоминание", ["napominanie"])).toBe("napominanie_2");
  });

  it("пустое название не ломает код", () => {
    expect(codeFromTitle("!!!")).toBe("template");
  });
});

describe("{{address}}", () => {
  it("подставляется из настроек клиники", () => {
    expect(fillTemplate("Ждём вас: {{address}}", { address: "ул. Островского, 20А" })).toEqual({ ok: true, text: "Ждём вас: ул. Островского, 20А" });
  });
  it("не задан — отправка отменяется и сказано, где заполнить", () => {
    const r = fillTemplate("Ждём вас: {{address}}", { address: null });
    expect(r).toEqual({ ok: false, missing: ["address"] });
    expect(missingLabel(["address"])).toMatch(/Настройки → Клиника/);
  });
});
