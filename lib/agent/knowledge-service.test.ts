import { describe, expect, it } from "vitest";
import { knowledgeOnlyService } from "./knowledge-service";

const knowledge = [
  { topic: "Сколько стоит ТРН и сколько процедур?", question: "стоимость ТРН", answer: "Курс ТРН состоит из 10 процедур по 20 минут." },
  {
    topic: "с чего начать iv терапию",
    question: "хочу на IV",
    answer: "Если вы впервые планируете IV-терапию, оптимально начать с «Био-Старта». БАЗА — 7 000 ₽, PRO — 10 800 ₽.",
  },
  { topic: "БОС", question: "что такое БОС", answer: "БОС-терапия — тренировочный метод." },
  {
    topic: "Подготовка к остеопатии",
    question: "что взять с собой",
    answer: "Если у вас есть результаты обследований, МРТ, КТ, рентген — можете взять их с собой.",
  },
];
const ivKnowledge = [
  ...knowledge,
  {
    topic: "Сколько стоит IV-терапия?",
    question: "сколько стоит капельница/ цена капельницы",
    answer: "Программы стоят примерно от 4 000 до 10 800 ₽ за процедуру.",
  },
];
const titles = [
  "Нейромедитация",
  'Инфузия "Био-Ресурс"',
  'Пакет "БАЗА"',
  "БОС-терапия",
  "Внутривенное капельное введение растворов (IV-терапия)",
  "НАК метод (нейроаккустическая коррекция)",
];

describe("knowledgeOnlyService", () => {
  it("ТРН и Био-Старт — услуги из справки, которых в прайсе под этим именем нет", () => {
    expect(knowledgeOnlyService("Хочу записаться на ТРН", knowledge, titles)).toBe("ТРН");
    expect(knowledgeOnlyService("Хочу записаться на Био-Старт", knowledge, titles)).toBe("Био-Старт");
  });

  it("имя, которое есть в прайсе, подбирается по прайсу", () => {
    expect(knowledgeOnlyService("Хочу на БОС", knowledge, titles)).toBeNull();
    expect(knowledgeOnlyService("Хочу на НАК", knowledge, titles)).toBeNull();
    expect(knowledgeOnlyService("Пакет БАЗА сколько?", knowledge, titles)).toBeNull();
  });

  it("обычные слова и незнакомые сокращения не в счёт", () => {
    expect(knowledgeOnlyService("Хочу к остеопату", knowledge, titles)).toBeNull();
    expect(knowledgeOnlyService("Хочу записаться к остеопату", knowledge, titles)).toBeNull();
    expect(knowledgeOnlyService("Нужна справка для ГТО", knowledge, titles)).toBeNull();
  });

  it("упоминание мимоходом услугу не называет: «возьмите с собой МРТ»", () => {
    expect(knowledgeOnlyService("Сколько стоит МРТ?", knowledge, titles)).toBeNull();
  });

  it("капельница вообще — к справке, а не к строке «введение растворов 500 ₽»", () => {
    expect(knowledgeOnlyService("Хочу на капельницу, давно хотела попробовать", ivKnowledge, titles)).toBe("капельницу");
    expect(knowledgeOnlyService("Сколько стоит капельница?", ivKnowledge, titles)).toBe("капельница");
    expect(knowledgeOnlyService("Сколько стоит IV-терапия?", ivKnowledge, titles)).toBe("IV-терапия");
    // Справки о капельницах с ценой нет — подбор по прайсу.
    expect(knowledgeOnlyService("Хочу на капельницу", knowledge.slice(0, 1), titles)).toBeNull();
  });

  it("названа инфузия или свой препарат — подбор по прайсу", () => {
    expect(knowledgeOnlyService("Хочу капельницу Био-Ресурс", ivKnowledge, titles)).toBeNull();
    expect(knowledgeOnlyService("Можно капельницу, раствор свой", ivKnowledge, titles)).toBeNull();
  });
});

import { unknownServiceName } from "./knowledge-service";

describe("unknownServiceName", () => {
  const knowledge = [{ topic: "Что такое ТРН", question: "ТРН", answer: "Курс ТРН — 15 000 ₽." }];
  const titles = ["БОС-терапия", "НАК метод"];
  it("МРТ и УЗИ — услуг таких нет", () => {
    expect(unknownServiceName("Сколько стоит МРТ?", knowledge, titles)).toBe("МРТ");
    expect(unknownServiceName("А УЗИ делаете?", knowledge, titles)).toBe("УЗИ");
  });
  it("свои сокращения и служебные слова — не в счёт", () => {
    expect(unknownServiceName("Сколько стоит БОС?", knowledge, titles)).toBeNull();
    expect(unknownServiceName("Хочу на ТРН", knowledge, titles)).toBeNull();
    expect(unknownServiceName("Прислать ФИО?", knowledge, titles)).toBeNull();
    expect(unknownServiceName("Сколько стоит приём?", knowledge, titles)).toBeNull();
  });
  it("диагноз и анализ в чужой фразе — не вопрос об услуге", () => {
    expect(unknownServiceName("БОС поможет при СДВГ? Сыну 8 лет", knowledge, titles)).toBeNull();
    expect(unknownServiceName("Завтра придёт Гулбарият, взять ОАК", knowledge, titles)).toBeNull();
    expect(unknownServiceName("Что лучше ребенку — БОС или НАК?", knowledge, titles)).toBeNull();
    expect(unknownServiceName("Хочу записаться на МРТ", knowledge, titles)).toBe("МРТ");
  });
});
