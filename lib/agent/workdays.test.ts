import { describe, expect, it } from "vitest";
import { daysAsked, staffAsked, whoWorks } from "./workdays";

/**
 * Живой диалог, из-за которого правило появилось: «работаете ли вы в выходные
 * дни? И сколько у вас стоит приём?» — агент назвал цены обоих остеопатов, а
 * в субботу принимает только одна.
 */
const STAFF = [
  { name: "Ирина Алилгаджиевна", specialty: "остеопат", workdays: [1, 2, 3, 4] },
  { name: "Разият Ризвановна", specialty: "остеопат", workdays: [1, 2, 3, 4, 5, 6] },
  { name: "Новый специалист", specialty: "невролог", workdays: [] },
];

describe("дни недели в вопросе", () => {
  it("узнаёт названные дни", () => {
    expect(daysAsked("Можно в субботу?")).toEqual([6]);
    expect(daysAsked("А в пятницу или субботу?")).toEqual([5, 6]);
    expect(daysAsked("Работаете в воскресенье?")).toEqual([7]);
  });

  it("«выходные» — это суббота и воскресенье", () => {
    expect(daysAsked("Работаете ли вы в выходные дни?")).toEqual([6, 7]);
  });

  it("вопрос без дня недели дней не даёт", () => {
    expect(daysAsked("Сколько стоит приём остеопата?")).toEqual([]);
    expect(daysAsked("Хочу записаться завтра")).toEqual([]);
  });
});

describe("кто принимает в эти дни", () => {
  it("в субботу принимает только Разият", () => {
    const { works, off } = whoWorks(STAFF, [6]);
    expect(works.map((s) => s.name)).toEqual(["Разият Ризвановна"]);
    expect(off.map((s) => s.name)).toEqual(["Ирина Алилгаджиевна"]);
  });

  it("в пятницу — тоже только Разият", () => {
    expect(whoWorks(STAFF, [5]).works.map((s) => s.name)).toEqual(["Разият Ризвановна"]);
  });

  it("в среду принимают обе", () => {
    expect(whoWorks(STAFF, [3]).works).toHaveLength(2);
  });

  it("в воскресенье не принимает никто", () => {
    expect(whoWorks(STAFF, [7]).works).toHaveLength(0);
  });

  it("врач без заданных дней не попадает ни в один список", () => {
    const { works, off } = whoWorks(STAFF, [6]);
    expect([...works, ...off].some((s) => s.name === "Новый специалист")).toBe(false);
  });
});

describe("названный врач", () => {
  it("узнаётся в любом падеже", () => {
    expect(staffAsked("Можно в субботу к Ирине Алилгаджиевне?", STAFF)?.name).toBe(
      "Ирина Алилгаджиевна",
    );
    expect(staffAsked("А Разият Ризвановна работает в пятницу?", STAFF)?.name).toBe(
      "Разият Ризвановна",
    );
  });

  it("без имени возвращает null", () => {
    expect(staffAsked("Работаете в субботу?", STAFF)).toBeNull();
  });
});
