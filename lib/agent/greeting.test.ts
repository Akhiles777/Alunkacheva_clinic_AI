import { describe, expect, it } from "vitest";
import { greetingText, DEFAULT_GREETING } from "./greeting";
import { isGreeting } from "./text-actions";
import { alreadyGreeted } from "./repetition";

/**
 * Поздоровались — здороваемся в ответ. Правило кажется мелочью, но нарушалось
 * уже дважды, и каждый раз пациент видел собеседника, который не отвечает на
 * приветствие.
 */
describe("ответ на приветствие", () => {
  it("в первый раз — приветствие клиники из настроек", () => {
    expect(greetingText({ configured: "Здравствуйте! Клиника на связи.", repeat: false })).toBe(
      "Здравствуйте! Клиника на связи.",
    );
  });

  it("настройки пустые — своё приветствие, а не молчание", () => {
    expect(greetingText({ configured: "   ", repeat: false })).toBe(DEFAULT_GREETING);
    expect(greetingText({ configured: null, repeat: false })).toBe(DEFAULT_GREETING);
  });

  it("повторное приветствие всё равно начинается с приветствия", () => {
    const again = greetingText({ configured: "Здравствуйте! Клиника на связи.", repeat: true });
    // Прежде здесь было «Слушаю вас.» — ответ без единого приветственного
    // слова, и он читался как нежелание здороваться.
    expect(again.startsWith("Здравствуйте")).toBe(true);
    expect(again).not.toBe(DEFAULT_GREETING);
  });

  it("на повторе не зачитывает вводную заново", () => {
    const first = greetingText({ configured: null, repeat: false });
    const second = greetingText({ configured: null, repeat: true });
    expect(second.length).toBeLessThan(first.length);
  });

  it("короткий ответ сам считается приветствием", () => {
    // Иначе на третье «здравствуйте» бот решил бы, что ещё не здоровался, и
    // выдал полную вводную посреди разговора.
    const short = greetingText({ configured: null, repeat: true });
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
