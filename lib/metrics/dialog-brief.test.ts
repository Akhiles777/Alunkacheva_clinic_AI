import { describe, expect, it } from "vitest";
import {
  briefOf,
  MIN_MESSAGES_FOR_BRIEF,
  topicsOf,
  type BriefFacts,
  type BriefMessage,
} from "./dialog-brief";

const NOW = new Date("2026-09-10T12:00:00+03:00");

const msg = (p: Partial<BriefMessage> = {}): BriefMessage => ({
  direction: "IN",
  fromBot: false,
  text: "Здравствуйте",
  at: new Date("2026-09-01T10:00:00+03:00"),
  ...p,
});

const many = (n: number): BriefMessage[] =>
  Array.from({ length: n }, (_, i) =>
    msg({
      direction: i % 2 === 0 ? "IN" : "OUT",
      at: new Date(new Date("2026-09-01T10:00:00+03:00").getTime() + i * 3600_000),
    }),
  );

const facts = (p: Partial<BriefFacts> = {}): BriefFacts => ({
  messages: many(MIN_MESSAGES_FOR_BRIEF),
  visits: 3,
  lastVisitAt: new Date("2026-08-20T10:00:00+03:00"),
  nextVisitAt: null,
  course: null,
  escalationReason: null,
  ...p,
});

describe("сводка диалога", () => {
  it("короткую переписку не пересказываем: всё видно глазами", () => {
    expect(briefOf(facts({ messages: many(3) }), NOW).lines).toEqual([]);
  });

  it("считает сообщения и говорит, с какого числа", () => {
    const b = briefOf(facts(), NOW);
    expect(b.lines[0]).toContain("1 сентября");
    expect(b.lines[0]).toContain("от пациента");
  });

  it("пациент без визитов назван прямо, а не нулём", () => {
    const b = briefOf(facts({ visits: 0, lastVisitAt: null }), NOW);
    expect(b.lines[1]).toContain("Визитов ещё не было");
  });

  it("курс и ближайшая запись попадают в сводку", () => {
    const b = briefOf(
      facts({
        course: { title: "БОС-терапия", used: 4, total: 10 },
        nextVisitAt: new Date("2026-09-12T10:00:00+03:00"),
      }),
      NOW,
    );
    expect(b.lines.join(" ")).toContain("4 из 10");
    expect(b.lines.join(" ")).toContain("12 сентября");
  });

  it("последним написал пациент — говорим, что ответа не было", () => {
    const messages = [
      ...many(MIN_MESSAGES_FOR_BRIEF),
      msg({ direction: "IN", at: new Date("2026-09-10T11:30:00+03:00") }),
    ];
    const b = briefOf(facts({ messages }), NOW);
    expect(b.lines[b.lines.length - 1]).toContain("ответа ещё не было");
  });

  it("ответ агента ответом человека не считается", () => {
    const messages = [
      ...many(MIN_MESSAGES_FOR_BRIEF),
      msg({ direction: "OUT", fromBot: true, at: new Date("2026-09-10T11:00:00+03:00") }),
    ];
    const b = briefOf(facts({ messages }), NOW);
    expect(b.lines[b.lines.length - 1]).toContain("ассистент");
  });

  it("открытый вопрос к человеку называется", () => {
    const b = briefOf(facts({ escalationReason: "медицинский вопрос" }), NOW);
    expect(b.lines.join(" ")).toContain("медицинский вопрос");
  });
});

describe("о чём спрашивал", () => {
  it("темы узнаются по словам пациента", () => {
    const t = topicsOf([
      msg({ text: "Сколько стоит приём остеопата?" }),
      msg({ text: "И можно записать ребёнка?" }),
    ]);
    expect(t).toContain("цена");
    expect(t).toContain("запись");
    expect(t).toContain("ребёнок");
  });

  it("наши ответы темами не считаются", () => {
    const t = topicsOf([
      msg({ direction: "OUT", text: "Приём стоит 8000 ₽, вот наш прайс" }),
      msg({ direction: "IN", text: "Спасибо" }),
    ]);
    expect(t).toEqual([]);
  });
});
