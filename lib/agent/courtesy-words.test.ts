import { describe, expect, it } from "vitest";
import { amenOnly, collapseFormulas, courtesyFormulaWord, thanksFormula } from "./courtesy-words";
import { isAcknowledgement, isThanks, smallTalkReply } from "./smalltalk";
import { agentAskedSomething, nothingToAnswer } from "./unanswered-rule";
import { matchServices } from "./service-match";

/**
 * Живой диалог 9 октября: «джазакиЛляху хайран» получило «Ва iyyaka» и прайс,
 * «амин» — инфузию «Амино-Архитектура» за 8500 ₽ и просьбу прислать ФИО.
 */
const words = (t: string) =>
  collapseFormulas(t.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim()).split(" ");

describe("вежливые формулы", () => {
  it("узнаёт благодарность и пожелание в разных написаниях", () => {
    for (const t of [
      "джазакиЛляху хайран",
      "ДжазакаЛлаху хайр",
      "джазак Аллаху хайран",
      "баракаЛлаху фики",
      "амин",
      "Аминь",
      "ин ша Аллах",
      "иншаАллах",
      "маша Аллах",
      "альхамдулиллях",
      "Ва ийяки",
    ]) {
      expect(words(t).every(courtesyFormulaWord), t).toBe(true);
    }
  });

  it("имена формулой не считаются", () => {
    for (const t of ["Маша", "Амина", "Аминат", "Хадижат"]) {
      expect(words(t).every(courtesyFormulaWord), t).toBe(false);
    }
  });

  it("благодарность — только по ядру формулы", () => {
    expect(thanksFormula("джазакилляху хайран")).toBe(true);
    expect(thanksFormula("баракаллаху фики")).toBe(true);
    expect(thanksFormula("амин")).toBe(false);
    expect(thanksFormula("ва")).toBe(false);
  });

  it("«амин» — всегда без ответа, «Амин 5 лет» — нет", () => {
    expect(amenOnly("амин")).toBe(true);
    expect(amenOnly("Аминь 🤲")).toBe(true);
    expect(amenOnly("амин?")).toBe(false);
    expect(amenOnly("Амин 5 лет")).toBe(false);
  });
});

describe("вежливость в правилах ответа", () => {
  it("формулы — жест вежливости, отвечать нечем", () => {
    for (const t of ["джазакиЛляху хайран", "амин", "иншаАллах", "Спасибо большое, джазакаЛлаху хайран 🌷"]) {
      expect(nothingToAnswer(t), t).toBe(true);
    }
    // Анкета с именем Амин — не вежливость.
    expect(nothingToAnswer("Амин Магомедов 5 лет")).toBe(false);
  });

  it("на благодарность формулой — русское «и вам всего доброго», без латиницы", () => {
    expect(isThanks("джазакиЛляху хайран")).toBe(true);
    expect(isAcknowledgement("джазакиЛляху хайран")).toBe(false);
    expect(smallTalkReply("джазакиЛляху хайран")).toBe("И вам всего доброго! Если что-то понадобится — напишите.");
    expect(smallTalkReply("Спасибо")).toBe("Пожалуйста! Если что-то понадобится — напишите.");
  });

  it("«иншаАллах» — подтверждение, а не благодарность", () => {
    expect(isAcknowledgement("иншаАллах")).toBe(true);
    expect(isThanks("иншаАллах")).toBe(false);
  });
});

describe("приглашение на будущее — не вопрос", () => {
  it("«Если что-то понадобится — напишите» ни о чём не спрашивает", () => {
    expect(agentAskedSomething("И вам всего доброго! Если что-то понадобится — напишите.")).toBe(false);
    expect(agentAskedSomething("Понимаю. Если захотите вернуться к вопросу, напишите здесь, и поможем.")).toBe(false);
    expect(agentAskedSomething("Хорошо, если появятся вопросы — я здесь.")).toBe(false);
  });

  it("просьба назвать выбор — по-прежнему вопрос", () => {
    expect(agentAskedSomething("Если хотите записаться — напишите, к кому из врачей и для кого приём.")).toBe(true);
    expect(agentAskedSomething("Если появятся вопросы, напишите, а пока скажите, для кого приём")).toBe(true);
    expect(agentAskedSomething("Ответьте «Да» или «Нет».")).toBe(true);
  });
});

describe("формула — не услуга", () => {
  const services = [
    { title: "Инфузия «Амино-Архитектура» — белковое восстановление", price: 8500, durationMin: 60 },
    { title: "Взрослый прием - остеопатия", price: 8000, durationMin: 45 },
  ];

  it("«амин» не находит «Амино-Архитектуру»", () => {
    expect(matchServices("амин", services)).toEqual([]);
    expect(matchServices("Аминь", services)).toEqual([]);
  });

  it("сама услуга по-прежнему находится", () => {
    expect(matchServices("сколько стоит Амино-Архитектура?", services).map((s) => s.price)).toEqual([8500]);
  });
});
