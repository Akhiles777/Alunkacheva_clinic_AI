import { describe, expect, it } from "vitest";
import { confirmationProblem, factsBlock, type StepFacts } from "./phrasing";

const STAFF = ["Алункачева Ирина Алилгаджиевна", "Мугадова Разият Ризвановна", "Омарова Ирина"];
const IRINA: StepFacts = {
  doctor: "Ирина Алилгаджиевна",
  service: { title: "Взрослый прием - остеопатия", price: 8000, durationMin: 45 },
  whom: "adult",
  patientMessage: "к Ирине А.",
};

describe("живое подтверждение шага записи", () => {
  it("факты одним блоком", () => {
    expect(factsBlock(IRINA)).toBe(
      "Врач: Ирина Алилгаджиевна\nУслуга: Взрослый прием - остеопатия — 8000 ₽, длительность 45 мин\nПриём для взрослого",
    );
  });

  it("живой текст из фактов проходит", () => {
    for (const t of [
      "Отлично, записываемся к Ирине Алилгаджиевне на взрослый приём остеопата — 8 000 ₽, приём длится 45 минут.",
      "Хорошо, к Ирине Алилгаджиевне: взрослый приём остеопата стоит 8000 ₽ и длится 45 минут.",
    ]) {
      // «записываемся» — не обещание записать: проверка обещаний ищет «запишу/записываю/запишем».
      expect(confirmationProblem(t, IRINA, STAFF), t).toBeNull();
    }
  });

  it("чужая цена, чужой врач, свой вопрос — не отправляем", () => {
    expect(confirmationProblem("Хорошо, приём у Ирины Алилгаджиевны — 5000 ₽.", IRINA, STAFF)).toMatch(/число/);
    expect(confirmationProblem("Хорошо, длится около 30 минут.", IRINA, STAFF)).toMatch(/число/);
    expect(confirmationProblem("Хорошо, к Разият Ризвановне — 8000 ₽.", IRINA, STAFF)).toMatch(/чужой врач/);
    expect(confirmationProblem("Хорошо, к Ирине Алилгаджиевне. Удобно в субботу?", IRINA, STAFF)).toMatch(/вопрос/);
  });

  it("обещание записать и просьба данных — дело кода", () => {
    expect(confirmationProblem("Хорошо, запишу вас к Ирине Алилгаджиевне.", IRINA, STAFF)).toMatch(/обещание/);
    expect(
      confirmationProblem("Хорошо. Пришлите, пожалуйста, ФИО и возраст одним сообщением.", IRINA, STAFF),
    ).toMatch(/данных/);
  });

  it("возраст из слов пациента — не выдумка", () => {
    const child: StepFacts = {
      doctor: "Разият Ризвановна",
      service: { title: "Остеопатия - дети, прием Разият", price: 4000, durationMin: 40 },
      whom: "child",
      patientMessage: "к Разият, сыну 6 лет",
    };
    expect(confirmationProblem("Хорошо, к Разият Ризвановне: детский приём для сына 6 лет — 4000 ₽, 40 минут.", child, STAFF)).toBeNull();
  });

  it("тёзка не считается чужим врачом", () => {
    expect(confirmationProblem("Отлично, Ирина Алилгаджиевна — 8000 ₽, 45 минут.", IRINA, STAFF)).toBeNull();
  });
});

describe("про администратора и время подтверждение не говорит", () => {
  it("«администратор сейчас подберёт время» отклоняется — это ставит код", () => {
    const facts: StepFacts = {
      doctor: "Ирина Алилгаджиевна",
      service: { title: "Детский прием до 10 л - остеопатия", price: 5000, durationMin: 40 },
      whom: "child",
      patientMessage: "Ребенок, новорожденный, 12 дней. Выгибание шеи когда лежит",
    };
    expect(
      confirmationProblem(
        "Понял, детский приём остеопата Ирины для новорожденного. Стоит 5000 рублей, длится 40 минут. Администратор сейчас подберёт вам свободное время.",
        facts,
        STAFF,
      ),
    ).not.toBeNull();
    expect(
      confirmationProblem("Поняла, детский приём остеопата у Ирины Алилгаджиевны — 5000 ₽, 40 минут.", facts, STAFF),
    ).toBeNull();
  });
});
