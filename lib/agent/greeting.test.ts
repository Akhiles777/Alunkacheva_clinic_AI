import { describe, expect, it } from "vitest";
import { greetingText, DEFAULT_INTRO } from "./greeting";
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
