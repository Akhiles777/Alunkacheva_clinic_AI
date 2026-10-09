import { describe, expect, it } from "vitest";
import { dropsBooking, medical, wantsToBook } from "./triggers";
import { staffHandlesBooking } from "./booking-flow";
import { complexMedical } from "./specialist-rules";
import { asksForIntake } from "./intake";
import { foreignScriptWords, withoutForeignScript } from "./grounding";
import { STAFF_MARK, stripPreamble } from "./llm";

/**
 * Живой диалог 9 октября и то, что вскрыл его прогон: правила, из-за которых
 * агент утром начал запись заново, ответил о диагнозе сам и писал латиницей.
 */
describe("человек сам закрыл разговор о записи", () => {
  it("отложил или передумал", () => {
    for (const t of [
      "спасибо большое 🌷 тогда узнаю у врача",
      "нельзя оказывается\nхорошо, что уточнили",
      "Подумаю",
      "посоветуюсь с мужем и напишу",
      "уже не актуально",
      "Я позже запишусь",
      "мы не будем записываться",
    ]) {
      expect(dropsBooking(t), t).toBe(true);
    }
  });

  it("просьба и вопрос — не отказ", () => {
    for (const t of [
      "уточните, есть ли окошко?",
      "Хочу записаться к Ирине",
      "Как я узнаю, что запись подтверждена?",
      "а у вас нельзя оплатить картой?",
      "ребенку 6 лет",
    ]) {
      expect(dropsBooking(t), t).toBe(false);
    }
  });
});

describe("запись ведёт администратор", () => {
  it("предложил время или попросил данные", () => {
    for (const t of [
      "Есть свободное окошко на зачтра в 9:30 , записать Вас?",
      "Могу предложить во вторник 13 октября в 13:30 , удобно будет?",
      "Для записи пришлите пожалуйста информацию о ребенке Ф. И. О. возраст. И как Вас зовут?",
    ]) {
      expect(staffHandlesBooking(t), t).toBe(true);
    }
  });

  it("вопрос шага, приветствие и справка — не ведение записи", () => {
    for (const t of [
      "К кому хотите записаться — Алункачева Ирина Алилгаджиевна или Мугадова Разият Ризвановна?",
      "Ваалейкум ас-Салам",
      "Хорошо перешлю вопрос врачу и вернусь с ответом",
      "Работаем с 09:00 до 21:00",
      "В субботу принимает другой доктор остеопат Разият Ризвановна",
    ]) {
      expect(staffHandlesBooking(t), t).toBe(false);
    }
  });
});

describe("тяжёлый диагноз — вопрос врачу", () => {
  it("артрогрипоз с опечаткой и описание движений", () => {
    const t = "у сына 1,2г ортрогрипоз, пальцы рук не сгибает и ноги не до конца ставит при ходьбе";
    expect(complexMedical(t)).toBe(true);
    expect(medical(t)).toBe(true);
    expect(medical("Ребенок не держит голову в 4 месяца")).toBe(true);
  });

  it("частый повод к остеопату врача не будит", () => {
    expect(complexMedical("у малыша 3 мес гипертонус, хотим к остеопату")).toBe(false);
    expect(complexMedical("Сколько стоит анализ на глюкозу?")).toBe(false);
  });
});

describe("приветствие модели — не анкета", () => {
  it("«соберу нужные данные» — обещание, а не просьба", () => {
    expect(asksForIntake("Если захотите записаться, я соберу нужные данные и передам администратору.")).toBe(false);
    expect(asksForIntake("Для записи нужны ФИО и возраст ребёнка")).toBe(true);
  });
});

describe("«хотела бы проконсультироваться» — просьба о приёме", () => {
  it("узнаётся", () => {
    expect(wantsToBook("хотела бы проконсультироваться")).toBe(true);
    expect(wantsToBook("хотим проконсультироваться с остеопатом")).toBe(true);
  });
});

describe("латиница посреди русской фразы", () => {
  const ref = "Внутривенное введение (IV-терапия) — 500 ₽. BRAINBI — 3000 ₽.";

  it("ловит смешанные слова и чужие латинские", () => {
    expect(foreignScriptWords("Ва iyyaka 🌿 Будьте здоровы!", ref)).toEqual(["iyyaka"]);
    expect(foreignScriptWords("Ваalaйкум ассалям! Чем могу помочь?", ref)).toEqual(["Ваalaйкум"]);
  });

  it("слова из справки, мессенджеры и ссылки не трогает", () => {
    expect(foreignScriptWords("IV-терапия стоит 500 ₽, BRAINBI — 3000 ₽.", ref)).toEqual([]);
    expect(foreignScriptWords("Напишите нам в WhatsApp.", ref)).toEqual([]);
    expect(foreignScriptWords("Политика: https://alunkachevaclinic.ru/policy", ref)).toEqual([]);
  });

  it("убирает предложение, а ссылку не режет", () => {
    expect(withoutForeignScript("Политика: https://alunkachevaclinic.ru/policy. Ва iyyaka! Хорошего дня.", ref)).toBe(
      "Политика: https://alunkachevaclinic.ru/policy. Хорошего дня.",
    );
  });
});

describe("пометка реплик сотрудника пациенту не уходит", () => {
  it("снимается с ответа модели", () => {
    expect(stripPreamble(`ОТВЕТ: ${STAFF_MARK} Приём длится 40 минут.`)).toBe("Приём длится 40 минут.");
  });
});

describe("живое подтверждение шага — без рассуждений о себе", () => {
  it("«пока не знаю, назову позже» и «сейчас уточню» уходят шаблоном", async () => {
    const { confirmationProblem } = await import("./phrasing");
    const facts: Parameters<typeof confirmationProblem>[1] = {
      doctor: "Ирина Алилгаджиевна",
      service: null,
      whom: "unknown",
      patientMessage: "Хочу записаться к Ирине Алилгаджиевне",
    };
    const staff = ["Ирина Алилгаджиевна", "Разият Ризвановна"];
    expect(
      confirmationProblem("Поняла, вы хотите на приём к Ирине Алилгаджиевне. Цену и длительность приёма пока не знаю, поэтому назову их позже.", facts, staff),
    ).toBe("рассуждение или обещание");
    expect(confirmationProblem("Поняла, вы хотите к Ирине Алилгаджиевне. Сейчас уточню детали приёма.", facts, staff)).toBe(
      "рассуждение или обещание",
    );
  });
});
