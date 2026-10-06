import { describe, expect, it } from "vitest";
import { asksRepeatVisit, repeatDoctor, type LastVisit } from "./repeat-visit";
import { asksHowToBook, wantsToBook } from "./triggers";

/**
 * Живой диалог 5 октября: «Я всё-таки хотела бы на повторный приём попасть» —
 * просьба записать к тому же врачу; агент её не узнал и спросил врача.
 */
describe("повторный приём", () => {
  it("узнаётся как просьба записать и как повтор", () => {
    const t = "Я все таки хотела бы на повторный прием попасть";
    expect(asksHowToBook(t)).toBe(true);
    expect(wantsToBook(t)).toBe(true);
    expect(asksRepeatVisit(t)).toBe(true);
  });

  it("другие слова повтора", () => {
    for (const t of ["Хочу снова к остеопату", "Запишите ещё раз, как в прошлый раз", "Хочу к своему врачу", "Хотела продолжить лечение"]) {
      expect(asksRepeatVisit(t), t).toBe(true);
    }
  });

  it("первичный визит повтором не считается", () => {
    for (const t of ["Хочу записаться к остеопату", "Сколько стоит приём?", "Здравствуйте"]) {
      expect(asksRepeatVisit(t), t).toBe(false);
    }
  });
});

describe("к кому повторный приём, если врач назван", () => {
  const osteo = { staff: { id: "ira", name: "Алункачева Ирина Алилгаджиевна" }, serviceId: "s1", serviceTitle: "Взрослый прием - остеопатия" };
  const bos = { staff: { id: "omar", name: "Омарова Ирина" }, serviceId: "s2", serviceTitle: "БОС-терапия" };
  const raz = { staff: { id: "raz", name: "Мугадова Разият Ризвановна" }, serviceId: "s3", serviceTitle: "Остеопатия, прием Разият" };
  const last = (visited: LastVisit["visited"]): LastVisit => ({ ...visited[0], visited });

  it("врача не назвали — прошлый визит", () => {
    expect(repeatDoctor(last([bos, osteo]), []).pick?.staff.id).toBe("omar");
  });

  it("«к Ирине», а был у обеих Ирин — двояко, спрашиваем", () => {
    const r = repeatDoctor(last([bos, osteo]), ["ira", "omar"]);
    expect(r.pick).toBeNull();
    expect(r.clash.map((v) => v.staff.id)).toEqual(["omar", "ira"]);
  });

  it("«к Ирине», а был у одной из Ирин — к ней, даже если последний визит к другому врачу", () => {
    const r = repeatDoctor(last([raz, osteo]), ["ira", "omar"]);
    expect(r.pick?.staff.id).toBe("ira");
    expect(r.pick?.serviceTitle).toBe("Взрослый прием - остеопатия");
  });

  it("названный врач, у которого человек не был, — не повтор", () => {
    const r = repeatDoctor(last([osteo]), ["raz"]);
    expect(r.pick).toBeNull();
    expect(r.clash).toEqual([]);
  });
});

describe("повторный приём — просьба записать", () => {
  it("слово повтора между желанием и врачом", () => {
    for (const t of ["Хочу повторно к Ирине", "Дочери говорили нужен повторный прием, хотела записаться", "Хотела бы снова к Разият", "Нужен повторный приём"]) {
      expect(wantsToBook(t), t).toBe(true);
    }
  });
});
