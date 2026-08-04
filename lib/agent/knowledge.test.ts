import { describe, expect, it } from "vitest";
import { confidentMatch, KNOWLEDGE_MIN_SCORE, matchKnowledge, type KnowledgeRow } from "./knowledge";

/**
 * Подбор справки — место, где ошибка означает выдуманный медицинский ответ
 * пациенту. Проверяем, что при непопадании ассистент молчит, а не «угадывает».
 */
const ROWS: KnowledgeRow[] = [
  { topic: "Адрес", question: "Где вы находитесь?", answer: "Москва, ул. Примерная, 1." },
  {
    topic: "Подготовка к капельнице",
    question: "Как готовиться к IV-терапии?",
    answer: "Лёгкий приём пищи за 1–2 часа до процедуры, обычный питьевой режим.",
  },
  {
    topic: "Противопоказания к остеопатии",
    question: "Кому нельзя остеопатию?",
    answer: "Острые воспаления, онкология в активной фазе, свежие травмы — приём переносится.",
  },
];

describe("matchKnowledge", () => {
  it("находит запись по теме подготовки", () => {
    const m = matchKnowledge("как готовиться к капельнице?", ROWS);
    expect(m?.row.topic).toBe("Подготовка к капельнице");
    expect(m!.score).toBeGreaterThanOrEqual(KNOWLEDGE_MIN_SCORE);
  });

  it("находит противопоказания", () => {
    const m = matchKnowledge("какие противопоказания к остеопатии", ROWS);
    expect(m?.row.topic).toBe("Противопоказания к остеопатии");
    expect(m!.score).toBeGreaterThanOrEqual(KNOWLEDGE_MIN_SCORE);
  });

  it("на посторонний вопрос уверенность ниже порога", () => {
    const m = matchKnowledge("а можно мне пить антибиотики вместе с этим", ROWS);
    expect(m === null || m.score < KNOWLEDGE_MIN_SCORE).toBe(true);
  });

  it("пустой справочник ничего не даёт", () => {
    expect(matchKnowledge("адрес", [])).toBeNull();
  });

  it("пустой вопрос ничего не даёт", () => {
    expect(matchKnowledge("   ", ROWS)).toBeNull();
  });
});

describe("confidentMatch", () => {
  it("односложный вопрос не считается уверенным совпадением", () => {
    // «а капельница?» — одно значимое слово, доля 1.0, но смысл неясен:
    // спрашивают цену или подготовку. Такое отдаём модели с контекстом.
    const m = matchKnowledge("а капельница?", ROWS);
    expect(m!.score).toBeGreaterThanOrEqual(KNOWLEDGE_MIN_SCORE);
    expect(confidentMatch(m)).toBe(false);
  });

  it("развёрнутый вопрос по теме — уверенное совпадение", () => {
    expect(confidentMatch(matchKnowledge("как готовиться к капельнице", ROWS))).toBe(true);
  });

  it("пустое совпадение не уверенное", () => {
    expect(confidentMatch(null)).toBe(false);
  });
});
