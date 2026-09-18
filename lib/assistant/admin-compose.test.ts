import { describe, expect, it } from "vitest";
import { composeMessage, delayTextFrom, sendAtFrom, situationOf } from "./admin-compose";

/** Пятница, 18 сентября 2026, 12:00 по клинике. */
const NOW = new Date("2026-09-18T12:00:00+03:00");

describe("когда отправить", () => {
  it("через N часов и минут", () => {
    expect(sendAtFrom("через 5 часов напиши Патимат", NOW)?.toISOString()).toBe(
      new Date(NOW.getTime() + 5 * 3600 * 1000).toISOString(),
    );
    expect(sendAtFrom("через 30 минут напомни", NOW)?.toISOString()).toBe(
      new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(),
    );
    expect(sendAtFrom("через час", NOW)?.getHours()).toBe(13);
  });

  it("в конкретное время", () => {
    const at = sendAtFrom("напиши в 18:30", NOW);
    expect(at?.getHours()).toBe(18);
    expect(at?.getMinutes()).toBe(30);
  });

  it("час уже прошёл — значит завтра", () => {
    const at = sendAtFrom("напиши в 9", NOW);
    expect(at?.getDate()).toBe(19);
    expect(at?.getHours()).toBe(9);
  });

  it("завтра утром — девять", () => {
    const at = sendAtFrom("завтра утром напомни всем", NOW);
    expect(at?.getDate()).toBe(19);
    expect(at?.getHours()).toBe(9);
  });

  it("времени нет — отправляем сейчас", () => {
    expect(sendAtFrom("напиши Патимат что врач задерживается", NOW)).toBeNull();
  });

  it("прошедшее время не возвращаем", () => {
    // «сегодня в 9» в полдень — это уже прошло, и в прошлое мы не отправляем.
    expect(sendAtFrom("сегодня в 9 напиши", NOW)).toBeNull();
  });
});

describe("о чём сообщение", () => {
  it("узнаёт ситуацию", () => {
    expect(situationOf("врач задерживается")).toBe("delay");
    expect(situationOf("врач заболел")).toBe("sick");
    expect(situationOf("приём нужно перенести")).toBe("reschedule");
    expect(situationOf("напомни о записи")).toBe("remind");
    expect(situationOf("клиника сегодня не работает")).toBe("closed");
    expect(situationOf("просто спросить")).toBeNull();
  });

  it("на сколько задерживается — только если сказано", () => {
    expect(delayTextFrom("задерживается на 30 минут")).toBe("примерно на 30 минут");
    expect(delayTextFrom("задерживается на час")).toBe("примерно на час");
    expect(delayTextFrom("врач задерживается")).toBeNull();
  });
});

describe("текст сообщения", () => {
  it("задержка: без выдуманного времени", () => {
    const text = composeMessage("delay", {
      doctorName: "Ирина Алилгаджиевна",
      visitTime: "14:30",
      visitDay: "сегодня",
    });
    expect(text).toContain("Ирина Алилгаджиевна");
    expect(text).toContain("сегодня в 14:30");
    // Ни минут, ни часов задержки не называем: администратор их не назвал.
    expect(text).not.toMatch(/\d+\s*минут/);
  });

  it("задержка с указанным временем", () => {
    const text = composeMessage("delay", { delayText: "примерно на 30 минут" });
    expect(text).toContain("примерно на 30 минут");
  });

  it("напоминание называет день и время записи", () => {
    const text = composeMessage("remind", { visitDay: "завтра", visitTime: "09:40" });
    expect(text).toContain("завтра в 09:40");
  });

  it("перенос не обещает нового времени", () => {
    const text = composeMessage("reschedule", { visitDay: "сегодня", visitTime: "11:00" });
    expect(text).toContain("перенести");
    expect(text).toContain("когда вам удобно");
  });
});
