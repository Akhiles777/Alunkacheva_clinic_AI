import { describe, expect, it } from "vitest";
import { answerAboutPatient, SUGGESTED_QUESTIONS, type AnswerFacts, type AnswerVisit } from "./patient-answer";
import { glanceOf } from "./patient-glance";

const NOW = new Date("2026-09-14T09:00:00Z");

const v = (over: Partial<AnswerVisit>): AnswerVisit => ({
  status: "arrived",
  at: "2026-08-01T10:00:00Z",
  amount: 0,
  service: "Остеопатия",
  title: "Взрослый приём — остеопатия",
  doctor: "Ирина Алилгаджиевна",
  ...over,
});

const facts: AnswerFacts = {
  visits: [
    v({ at: "2026-06-01T10:00:00Z", amount: 8000, paidEarlier: true }),
    v({ at: "2026-07-01T10:00:00Z", status: "no_show" }),
    v({ at: "2026-08-10T10:00:00Z", amount: 2800, title: "БОС-терапия", service: "БОС-терапия", doctor: "Ирина Омарова" }),
    v({ at: "2026-08-20T10:00:00Z", amount: 8000 }),
    v({ at: "2026-09-20T10:00:00Z", status: "planned", service: "Остеопатия" }),
    v({ at: "2026-08-05T10:00:00Z", kind: "purchase", amount: 28000, title: "Курс БОС", service: "Курс БОС" }),
  ],
  courses: [{ title: "БОС-терапия", used: 4, total: 10, booked: 2, status: "active" }],
};

describe("answerAboutPatient", () => {
  it("на каждый готовый вопрос есть расчёт", () => {
    for (const q of SUGGESTED_QUESTIONS) {
      expect(answerAboutPatient(q, facts, NOW).known, q).toBe(true);
    }
  });

  it("долг совпадает со строкой карточки", () => {
    const g = glanceOf(facts.visits, facts.courses, NOW);
    const a = answerAboutPatient("Сколько он должен?", facts, NOW);
    expect(g.owes).toEqual({ amount: 10800, visits: 2 });
    expect(a.text.replace(/\s/g, " ")).toContain("10 800 ₽");
    expect(a.text).toContain("не счёт");
  });

  it("оплату не отмечают — должником не называем", () => {
    const unmarked: AnswerFacts = {
      visits: [v({ amount: 8000 }), v({ amount: 5000 })],
      courses: [],
    };
    expect(answerAboutPatient("Есть долг?", unmarked, NOW).text).toContain("Сказать нельзя");
  });

  it("последний раз у названного специалиста, а не последний визит вообще", () => {
    const a = answerAboutPatient("Когда последний раз был у остеопата?", facts, NOW);
    expect(a.text).toContain("20 августа");
    const bos = answerAboutPatient("когда последний раз была на БОС?", facts, NOW);
    expect(bos.text).toContain("10 августа");
  });

  it("ближайшая запись — из будущего", () => {
    expect(answerAboutPatient("Когда ближайшая запись?", facts, NOW).text).toContain("20 сентября");
    expect(answerAboutPatient("Ближайшая запись", { visits: [v({})], courses: [] }, NOW).text).toBe("Записей впереди нет.");
  });

  it("неявки и курс", () => {
    expect(answerAboutPatient("Сколько неявок?", facts, NOW).text).toBe("Не пришёл 1 раз из 4.");
    expect(answerAboutPatient("Покупал ли курс?", facts, NOW).text).toContain("4/10, записан ещё на 2");
  });

  it("история пришла не целиком — говорим об этом, а не выдаём часть за целое", () => {
    const many: AnswerFacts = { ...facts, truncated: true };
    expect(answerAboutPatient("Сколько раз приходил и на какую сумму?", many, NOW).text).toContain(
      "по последним ста визитам",
    );
    expect(answerAboutPatient("Когда был первый раз?", many, NOW).text).toContain("Самый ранний");
    expect(answerAboutPatient("Сколько неявок?", many, NOW).text).toContain("последним ста");
  });

  it("незнакомый вопрос — «не знаю», а не цифра", () => {
    const a = answerAboutPatient("Какой у него рост?", facts, NOW);
    expect(a.known).toBe(false);
    expect(a.text).not.toMatch(/\d/);
  });
});
