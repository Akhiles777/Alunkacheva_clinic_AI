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

describe("проверка обычных разговоров 9 октября", () => {
  it("«к любому», «без разницы» — врач выбран", async () => {
    const { anyDoctor } = await import("./booking-flow");
    for (const t of ["К любому, без разницы", "к любому врачу", "Без разницы", "кто свободен", "всё равно"]) {
      expect(anyDoctor(t), t).toBe(true);
    }
    expect(anyDoctor("не к любому, к Ирине")).toBe(false);
    expect(anyDoctor("Хочу к Ирине")).toBe(false);
  });

  it("двое детей — анкета на каждого", async () => {
    const { severalChildren } = await import("./service-match");
    expect(severalChildren("Хочу записать двоих детей 4 и 7 лет к Ирине")).toBe(true);
    expect(severalChildren("сына и дочку")).toBe(true);
    expect(severalChildren("сына 5 лет")).toBe(false);
    expect(severalChildren("Мне 34, сыну 7")).toBe(false);
  });

  it("«кто из врачей лучше?» узнаётся", async () => {
    const { comparesDoctors } = await import("./booking-flow");
    expect(comparesDoctors("Ребенку 3 месяца, хотим к остеопату. Кто из врачей лучше?")).toBe(true);
    expect(comparesDoctors("к кому лучше записаться?")).toBe(true);
    expect(comparesDoctors("Хочу к Ирине")).toBe(false);
  });

  it("вопрос о цене — не вопрос о своей записи", async () => {
    const { asksAboutOwnBooking } = await import("./triggers");
    expect(asksAboutOwnBooking("Сколько стоит приём? Мне 25")).toBe(false);
    expect(asksAboutOwnBooking("Когда у меня приём?")).toBe(true);
  });

  it("«не знаю, к какому врачу» в просьбе записать — не медицинский вопрос", async () => {
    const { complaintAsReason } = await import("./booking-flow");
    expect(complaintAsReason("Хочу записаться, но не знаю к какому врачу, у ребенка сколиоз, 9 лет", true, true)).toBe(true);
    expect(complaintAsReason("У ребёнка сколиоз, не знаю, что делать, хочу записаться", true, true)).toBe(false);
  });
});

describe("«справка» пациенту не звучит", () => {
  it("предложение о том, чего в справке нет, уходит; оборот снимается", async () => {
    const { withoutReferenceTalk } = await import("./grounding");
    expect(
      withoutReferenceTalk("Скидок для инвалидов в справке клиники нет, поэтому точно ответить не могу. Уточню у администратора."),
    ).toBe("Уточню у администратора.");
    expect(withoutReferenceTalk("Патимат, по нашей справке БОС-терапия помогает учиться управлять дыханием.")).toBe(
      "Патимат, БОС-терапия помогает учиться управлять дыханием.",
    );
    expect(withoutReferenceTalk("В справке указано, что курс обычно состоит из 10 сеансов.")).toBe(
      "Курс обычно состоит из 10 сеансов.",
    );
    expect(withoutReferenceTalk("Приём остеопата — 5000 ₽, 45 минут.")).toBe("Приём остеопата — 5000 ₽, 45 минут.");
  });
});

describe("модель не опровергает наши прошлые ответы", () => {
  it("«Поправлю своё прошлое сообщение…» уходит", async () => {
    const { withoutSelfCorrection } = await import("./grounding");
    expect(
      withoutSelfCorrection(
        "Поправлю своё прошлое сообщение: детской цены на приём Ирины нет. Её приём стоит 8000 ₽, длится 45 минут.",
      ),
    ).toBe("Её приём стоит 8000 ₽, длится 45 минут.");
    expect(withoutSelfCorrection("Приём стоит 8000 ₽.")).toBe("Приём стоит 8000 ₽.");
  });
});

describe("стоп-слово — с начала слова", () => {
  it("«меню» не срабатывает на «изменю», «окошко» ловит «окошком»", async () => {
    const { hitsStopWord } = await import("./clinic-agent");
    expect(hitsStopWord("Я изменю время, можно?", ["меню"])).toBe(false);
    expect(hitsStopWord("Покажите меню капельниц", ["меню"])).toBe(true);
    expect(hitsStopWord("Есть окошком на завтра?", ["окошко"])).toBe(true);
    expect(hitsStopWord("Перенесите   запись на пятницу", ["перенесите запись"])).toBe(true);
    expect(hitsStopWord("Это моё", ["это"])).toBe(true);
  });
});

describe("угроза жизни — сначала скорая", () => {
  it("удушье, отёк Квинке, потеря сознания — да; анамнез — нет", async () => {
    const { lifeThreat } = await import("./triggers");
    for (const t of ["Задыхаюсь после капельницы", "у ребенка судороги сейчас", "отек квинке начался", "мама потеряла сознание"]) {
      expect(lifeThreat(t), t).toBe(true);
    }
    for (const t of ["у ребенка были судороги год назад, хотим к остеопату", "после родов было кровотечение", "Хочу записаться к остеопату"]) {
      expect(lifeThreat(t), t).toBe(false);
    }
  });
});

describe("снимок боевых данных: правила разговора", () => {
  it("взрослый мужчина — да; «с мужем», сын — нет", async () => {
    const { adultMaleMentioned } = await import("./triggers");
    expect(adultMaleMentioned("Здравствуйте, мужу нужен остеопат, можно записать?")).toBe(true);
    expect(adultMaleMentioned("Хочу записать отца к остеопату")).toBe(true);
    expect(adultMaleMentioned("Приду с мужем, можно?")).toBe(false);
    expect(adultMaleMentioned("Сыну 10 лет, к остеопату")).toBe(false);
  });

  it("вопрос об услуге — не шаг записи", async () => {
    const { infoQuestion } = await import("./triggers");
    expect(infoQuestion("Здравствуйте, хочу на капельницы, с чего начать?")).toBe(true);
    expect(infoQuestion("Что такое НАК?")).toBe(true);
    expect(infoQuestion("Хочу записаться к Ирине")).toBe(false);
  });

  it("«Расскажите про Лотос» находит Лотос", async () => {
    const { matchServices } = await import("./service-match");
    const services = [
      { title: "Лотос/Стандарт", price: 3000, durationMin: 45 },
      { title: "Остеопатия, приём Ирины", price: 8000, durationMin: 30 },
    ];
    expect(matchServices("Расскажите про Лотос, сколько стоит?", services, 6, 0.5).map((s) => s.price)).toEqual([3000]);
  });

  it("подбор справки: названная услуга решает", async () => {
    const { rankKnowledge, serviceStems } = await import("./knowledge");
    const rows = [
      { topic: "как подготовиться к капельнице", question: "что взять с собой на капельницу/ натощак на капельницу", answer: "IV" },
      { topic: "Подготовка к остеопатии", question: "Как готовиться к приёму остеопата?/ что взять к остеопату?", answer: "OSTEO" },
    ];
    const vocab = serviceStems(["Остеопатия, приём Ирины", 'Инфузия "Био-Ресурс"', "Внутривенное капельное введение растворов"]);
    expect(rankKnowledge("Что взять с собой к остеопату?", rows, vocab)[0].row.answer).toBe("OSTEO");
  });
});
