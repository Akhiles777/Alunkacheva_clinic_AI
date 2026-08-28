import { describe, expect, it } from "vitest";
import { DEFAULT_INTRO, greetingText, startsWithGreeting, stripLeadingGreeting, withoutOffer } from "./greeting";
import { isGreeting } from "./text-actions";
import { alreadyGreeted } from "./repetition";

/**
 * Как поздоровался пациент, так и отвечаем. Правило кажется мелочью, но
 * нарушалось уже трижды, и каждый раз человек видел собеседника, который
 * здоровается не с ним, а по бумажке.
 */
describe("ответ на приветствие", () => {
  const CLINIC = "Здравствуйте! Клиника на связи.";

  it("отвечает тем же приветствием", () => {
    expect(greetingText({ incoming: "Доброе утро", configured: CLINIC, repeat: false })).toMatch(
      /^Доброе утро!/,
    );
    expect(greetingText({ incoming: "Добрый вечер!", configured: CLINIC, repeat: false })).toMatch(
      /^Добрый вечер!/,
    );
    expect(greetingText({ incoming: "Привет", configured: CLINIC, repeat: false })).toMatch(/^Привет!/);
  });

  it("на салам отвечает ответным саламом", () => {
    for (const hello of ["Салам алейкум", "ассаламу алейкум", "салам"]) {
      expect(greetingText({ incoming: hello, configured: CLINIC, repeat: false }), hello).toMatch(
        /^Ва алейкум ассалам!/,
      );
    }
  });

  it("не здоровается дважды в одном сообщении", () => {
    // Клиника пишет вводную со своего «Здравствуйте!», и приклеить её к
    // ответному «Доброе утро!» значит поздороваться два раза подряд.
    const out = greetingText({ incoming: "Доброе утро", configured: CLINIC, repeat: false });
    expect(out).toBe("Доброе утро! Клиника на связи.");
  });

  it("в первый раз добавляет вводную клиники", () => {
    expect(greetingText({ incoming: "Здравствуйте", configured: CLINIC, repeat: false })).toContain(
      "Клиника на связи.",
    );
  });

  it("настройки пустые — своя вводная, а не молчание", () => {
    const out = greetingText({ incoming: "Здравствуйте", configured: "   ", repeat: false });
    expect(out).toBe(`Здравствуйте! ${DEFAULT_INTRO}`);
  });

  it("приветствие клиники — одно слово: не остаётся пустого хвоста", () => {
    expect(greetingText({ incoming: "Добрый день", configured: "Здравствуйте!", repeat: false })).toBe(
      "Добрый день!",
    );
  });

  it("повторное приветствие всё равно начинается с приветствия", () => {
    const again = greetingText({ incoming: "Салам алейкум", configured: CLINIC, repeat: true });
    // Прежде здесь было «Слушаю вас.» — ответ без единого приветственного
    // слова, и он читался как нежелание здороваться.
    expect(again).toBe("Ва алейкум ассалам! Слушаю вас.");
  });

  it("на повторе не зачитывает вводную заново", () => {
    const first = greetingText({ incoming: "Здравствуйте", configured: null, repeat: false });
    const second = greetingText({ incoming: "Здравствуйте", configured: null, repeat: true });
    expect(second.length).toBeLessThan(first.length);
    expect(second).not.toContain(DEFAULT_INTRO);
  });

  it("короткий ответ сам считается приветствием", () => {
    // Иначе на третье «здравствуйте» бот решил бы, что ещё не здоровался, и
    // выдал полную вводную посреди разговора.
    const short = greetingText({ incoming: "Здравствуйте", configured: null, repeat: true });
    expect(alreadyGreeted([{ role: "assistant", content: short }])).toBe(true);
  });

  it("узнаёт приветствия, с которыми пишут в клинику", () => {
    for (const hello of ["Здравствуйте", "здравствуйте!", "Добрый день", "привет", "Салам алейкум", "Ассаламу алейкум"]) {
      expect(isGreeting(hello), hello).toBe(true);
    }
    // Вопрос после приветствия — уже не приветствие: на него нужен ответ по сути.
    expect(isGreeting("Здравствуйте, сколько стоит остеопатия?")).toBe(false);
  });
});

/**
 * Встречное предложение помощи снимается, когда отвечать уже есть на что.
 * Клиника пишет его по-разному, и короткое «Чем помочь?» прежде оставалось —
 * пациент получал приветствие с вопросом и тут же ответ на свой вопрос.
 */
describe("приветствие без предложения помощи", () => {
  it("снимает предложение в любой форме", () => {
    expect(withoutOffer("Здравствуйте! Это клиника «Мера». Чем помочь?")).toBe(
      "Здравствуйте! Это клиника «Мера».",
    );
    expect(withoutOffer("Добрый день! Чем можем быть полезны?")).toBe("Добрый день!");
    expect(withoutOffer("Здравствуйте! Чем я могу вам помочь?")).toBe("Здравствуйте!");
  });

  it("вводную клиники не трогает", () => {
    const intro = "Здравствуйте! Вы обратились в Клинику доктора Алункачевой.";
    expect(withoutOffer(intro)).toBe(intro);
    expect(withoutOffer("Приём остеопата стоит 8000 ₽.")).toBe("Приём остеопата стоит 8000 ₽.");
  });
});

/**
 * Опечатка в приветствии уводила сообщение к модели, а та вместо приветствия
 * сочиняла ответ по контексту: пациентка написала «Здравствуйте», а услышала
 * «Пожалуйста! До встречи завтра». Опечатку дешевле знать в лицо, чем угадывать
 * похожесть.
 */
describe("опечатки в приветствии", () => {
  it("узнаёт частые описки", () => {
    for (const t of ["Здраствуйте", "здрасте", "Здраствуй"]) {
      expect(isGreeting(t), t).toBe(true);
    }
  });

  it("приветствие с вопросом приветствием не считается", () => {
    // Иначе на «Здраствуйте, сколько стоит приём?» уйдёт дежурная фраза
    // вместо ответа.
    expect(isGreeting("Здраствуйте, сколько стоит приём?")).toBe(false);
  });
});

/**
 * Второй раз за день не здороваемся.
 *
 * Диалог возвращается агенту через четыре часа. Человек, разговаривавший с
 * клиникой утром, спрашивает адрес — и слышит «Здравствуйте!» от собеседника,
 * который час назад отвечал ему на другой вопрос. Это выдаёт автоответчик.
 */
describe("приветствие в начале ответа", () => {
  it("узнаёт приветствие в первом предложении", () => {
    expect(startsWithGreeting("Здравствуйте! Адрес — Ленина, 5")).toBe(true);
    expect(startsWithGreeting("Доброе утро, слушаю вас")).toBe(true);
  });

  it("не считает приветствием упоминание в середине", () => {
    expect(startsWithGreeting("Работаем в будни с 8:00, добрый день начинается рано")).toBe(false);
    expect(startsWithGreeting("Адрес — Ленина, 5")).toBe(false);
  });

  it("снимает дежурное приветствие, оставляя ответ", () => {
    expect(stripLeadingGreeting("Здравствуйте! Адрес — Ленина, 5")).toBe("Адрес — Ленина, 5");
    expect(stripLeadingGreeting("Добрый день. Приём стоит 8 000 ₽")).toBe("Приём стоит 8 000 ₽");
  });

  it("обращение по имени не трогает: это не дежурная фраза", () => {
    expect(stripLeadingGreeting("Здравствуйте, Мария! Адрес — Ленина, 5")).toBe(
      "Здравствуйте, Мария! Адрес — Ленина, 5",
    );
  });

  it("ответ без приветствия оставляет как есть", () => {
    expect(stripLeadingGreeting("Адрес — Ленина, 5")).toBe("Адрес — Ленина, 5");
  });

  it("если кроме приветствия ничего нет — не опустошает ответ", () => {
    expect(stripLeadingGreeting("Здравствуйте!")).toBe("Здравствуйте!");
  });
});
