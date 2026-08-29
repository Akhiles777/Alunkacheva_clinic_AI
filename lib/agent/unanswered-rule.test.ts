import { describe, expect, it } from "vitest";
import { needsAnswer, QUIET_MINUTES, MAX_AGE_HOURS } from "./unanswered-rule";

const NOW = new Date("2026-08-17T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("кого добираем", () => {
  it("сообщение пациента висит без ответа — отвечаем", () => {
    expect(needsAnswer({ last: { direction: "IN", createdAt: minutesAgo(5) } }, NOW)).toBe(true);
  });

  it("последним говорил агент — второй ответ не нужен", () => {
    expect(needsAnswer({ last: { direction: "OUT", createdAt: minutesAgo(30) } }, NOW)).toBe(false);
  });

  it("сообщение только что пришло — обычная обработка ещё в пути", () => {
    expect(
      needsAnswer({ last: { direction: "IN", createdAt: minutesAgo(QUIET_MINUTES - 1) } }, NOW),
    ).toBe(false);
  });

  it("сообщение полудневной давности не догоняем", () => {
    expect(
      needsAnswer({ last: { direction: "IN", createdAt: minutesAgo(MAX_AGE_HOURS * 60 + 10) } }, NOW),
    ).toBe(false);
  });

  it("сотрудник взял диалог на себя — агент молчит и в доборе", () => {
    // Бот, перебивающий администратора, — худший баг в этой системе (§6.4).
    expect(
      needsAnswer(
        {
          last: { direction: "IN", createdAt: minutesAgo(20) },
          botPausedUntil: new Date(NOW.getTime() + 3600_000),
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("пауза кончилась — добор снова работает", () => {
    expect(
      needsAnswer(
        { last: { direction: "IN", createdAt: minutesAgo(20) }, botPausedUntil: minutesAgo(60) },
        NOW,
      ),
    ).toBe(true);
  });

  it("пустая переписка ничего не ломает", () => {
    expect(needsAnswer({}, NOW)).toBe(false);
  });
});

/**
 * Возврат диалога агенту не значит «переиграть старую переписку».
 *
 * Живой случай: разговор кончился в 13:50 репликой пациента «Ок», на которую
 * администратор уже ответил. Через четыре часа диалог вернулся агенту, добор
 * нашёл последнее сообщение пациента и написал «Хорошо, если появятся вопросы
 * — я здесь». Со стороны это бот, который очнулся и заговорил сам с собой.
 */
describe("после возврата агенту", () => {
  const pausedUntil = new Date(NOW.getTime() - 5 * 60_000);

  it("на сообщение, пришедшее при человеке, не отвечаем", () => {
    expect(
      needsAnswer(
        { last: { direction: "IN", createdAt: minutesAgo(240) }, botPausedUntil: pausedUntil },
        NOW,
      ),
    ).toBe(false);
  });

  it("на новое сообщение после возврата — отвечаем", () => {
    expect(
      needsAnswer(
        { last: { direction: "IN", createdAt: minutesAgo(4) }, botPausedUntil: pausedUntil },
        NOW,
      ),
    ).toBe(true);
  });

  it("паузы не было вовсе — правило ничего не меняет", () => {
    expect(
      needsAnswer({ last: { direction: "IN", createdAt: minutesAgo(10) } }, NOW),
    ).toBe(true);
  });
});
