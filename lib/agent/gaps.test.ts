import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupGaps, looksMedical, similarity, type GapQuestion } from "./gaps";
import { knowledgeUsable } from "./knowledge";
import { stemsOf } from "./knowledge";

const T = (iso: string) => new Date(iso);

let n = 0;
const ask = (text: string, over: Partial<GapQuestion> = {}): GapQuestion => ({
  id: `e${++n}`,
  conversationId: "c1",
  text,
  at: T("2026-09-01T10:00:00+03:00"),
  reason: "MISUNDERSTOOD",
  answer: null,
  ...over,
});

describe("похожесть вопросов", () => {
  it("считается от более короткого вопроса", () => {
    // «адрес» целиком входит в длинный вопрос: это один и тот же вопрос,
    // хотя по объединению совпадение было бы мизерным.
    const short = new Set(stemsOf("адрес"));
    const long = new Set(stemsOf("подскажите пожалуйста ваш адрес и как доехать"));
    expect(similarity(short, long)).toBe(1);
  });

  it("пустой набор ни на что не похож", () => {
    expect(similarity(new Set(), new Set(["адрес"]))).toBe(0);
  });
});

describe("группировка пробелов", () => {
  it("похожие формулировки собираются в одну группу", () => {
    const out = groupGaps([
      ask("где вы находитесь"),
      ask("подскажите адрес клиники"),
      ask("адрес клиники подскажите пожалуйста"),
    ]);
    const address = out.find((c) => c.count > 1);
    expect(address?.count).toBe(2);
    expect(out).toHaveLength(2);
  });

  it("разные вопросы в одну группу не сливаются", () => {
    const out = groupGaps([
      ask("сколько стоит остеопатия"),
      ask("есть ли у вас парковка"),
    ]);
    expect(out).toHaveLength(2);
  });

  /**
   * Результат не должен зависеть от порядка строк из базы: иначе одна и та же
   * неделя показывает то четыре группы, то шесть, и экрану перестают верить.
   */
  it("порядок строк на входе результат не меняет", () => {
    const items = [
      ask("сколько стоит приём остеопата", { at: T("2026-09-01T10:00:00+03:00") }),
      ask("цена приёма остеопата какая", { at: T("2026-09-02T10:00:00+03:00") }),
      ask("есть ли парковка рядом", { at: T("2026-09-03T10:00:00+03:00") }),
    ];
    const straight = groupGaps(items).map((c) => `${c.title}:${c.count}`);
    const reversed = groupGaps([...items].reverse()).map((c) => `${c.title}:${c.count}`);
    expect(reversed).toEqual(straight);
  });

  it("названием группы становится самая частая формулировка", () => {
    const out = groupGaps([
      ask("адрес клиники"),
      ask("адрес клиники"),
      ask("адрес клиники подскажите пожалуйста будьте добры"),
    ]);
    expect(out[0].title).toBe("адрес клиники");
  });

  it("вопрос без значимых слов в группы не идёт", () => {
    expect(groupGaps([ask("?"), ask("а вы там")])).toHaveLength(0);
  });

  it("группы упорядочены по частоте", () => {
    const out = groupGaps([
      ask("парковка есть у вас"),
      ask("сколько стоит остеопатия"),
      ask("остеопатия сколько стоит приём"),
    ]);
    expect(out[0].count).toBe(2);
  });

  it("ответы сотрудников собираются в группу, свежие сверху", () => {
    const out = groupGaps([
      ask("адрес клиники", {
        answer: { text: "Ленина 1", at: T("2026-09-01T11:00:00+03:00"), authorName: "Мила" },
      }),
      ask("адрес клиники подскажите", {
        answer: { text: "Ленина 1, второй этаж", at: T("2026-09-05T11:00:00+03:00"), authorName: "Мила" },
      }),
    ]);
    expect(out[0].answers.map((a) => a.text)).toEqual(["Ленина 1, второй этаж", "Ленина 1"]);
  });
});

describe("медицинские темы", () => {
  it("узнаются по словам вопроса", () => {
    expect(looksMedical("можно ли при беременности")).toBe(true);
    expect(looksMedical("а если сильно болит спина")).toBe(true);
    expect(looksMedical("во сколько вы открываетесь")).toBe(false);
  });

  it("«ё» не мешает", () => {
    expect(looksMedical("какие противопоказания")).toBe(true);
  });

  /**
   * Достаточно одного медицинского вопроса в группе: справка по группе
   * отвечает и ему тоже, а сочинённое противопоказание — это вред пациенту
   * (§6, правило 1), а не неточность в тексте.
   */
  it("группа медицинская, если медицинский хотя бы один вопрос", () => {
    const out = groupGaps([
      ask("сколько длится сеанс бос терапии"),
      ask("сколько длится сеанс бос терапии при беременности"),
    ]);
    expect(out[0].medical).toBe(true);
  });

  it("эскалация «медицинский вопрос» делает группу медицинской без слов-маркеров", () => {
    const out = groupGaps([ask("а мне это подойдёт", { reason: "MEDICAL_QUESTION" })]);
    expect(out[0].medical).toBe(true);
  });
});

/**
 * Главная защита блока: запись справочника не появляется сама.
 *
 * Ответ администратора в переписке — это текст для конкретного человека, с
 * оглядкой на его случай. Как справка он отвечает всем, и превращать одно в
 * другое вправе только человек, прочитавший текст. Проверяем структурно: в
 * коде разбора пробелов нет ни одной записи в справочник.
 */
describe("запись справочника не создаётся автоматически", () => {
  const files = ["lib/agent/gaps.ts", "lib/server/knowledge-gaps.ts"];
  const forbidden = [
    "knowledgeEntry.create",
    "knowledgeEntry.createMany",
    "knowledgeEntry.upsert",
    "knowledgeEntry.update",
    "knowledgeEntry.updateMany",
    "saveKnowledge",
  ];

  for (const file of files) {
    it(`${file} не пишет в справочник ни при каком условии`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const call of forbidden) {
        expect(source.includes(call)).toBe(false);
      }
    });
  }
});

describe("медицинская справка без утверждения врача не работает", () => {
  it("неутверждённая — не отдаётся агенту, даже если включена", () => {
    expect(knowledgeUsable({ isActive: true, needsDoctorApproval: true, approvedAt: null })).toBe(
      false,
    );
  });

  it("утверждённая — отдаётся", () => {
    expect(
      knowledgeUsable({ isActive: true, needsDoctorApproval: true, approvedAt: new Date() }),
    ).toBe(true);
  });

  it("обычная запись утверждения не требует", () => {
    expect(knowledgeUsable({ isActive: true })).toBe(true);
  });

  it("выключенная не работает независимо от утверждения", () => {
    expect(
      knowledgeUsable({ isActive: false, needsDoctorApproval: true, approvedAt: new Date() }),
    ).toBe(false);
  });
});
