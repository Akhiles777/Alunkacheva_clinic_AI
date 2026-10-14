import { describe, expect, it } from "vitest";
import { EMPTY_MEMORY, asksSameAgain, memoryFrom, nextMemory, ordinalOf, resolveRef, type AdminMemory } from "./admin-memory";

const two: AdminMemory = {
  focus: null,
  candidates: [
    { id: "p1", name: "Алиева Диана" },
    { id: "p2", name: "Магомедова Диана" },
  ],
  lastText: null,
};

describe("память разговора: «ей», «вторая», «нет, другой»", () => {
  it("местоимение указывает на того, о ком речь", () => {
    const m = { ...EMPTY_MEMORY, focus: "p9" };
    expect(resolveRef("а ей напиши, что перенос на понедельник", m)).toEqual({ kind: "patient", patientId: "p9", how: "pronoun" });
    expect(resolveRef("какой у него телефон?", m)).toMatchObject({ patientId: "p9" });
  });

  it("местоимение при нескольких кандидатах — не выбирает сам, просит уточнить", () => {
    expect(resolveRef("ей напиши", two)).toEqual({ kind: "choose", candidates: two.candidates });
  });

  it("без памяти местоимение ничего не значит", () => {
    expect(resolveRef("ей напиши", EMPTY_MEMORY)).toEqual({ kind: "none" });
  });

  it("выбор номером из показанного списка", () => {
    expect(resolveRef("вторая", two)).toEqual({ kind: "patient", patientId: "p2", how: "ordinal" });
    expect(resolveRef("2", two)).toMatchObject({ patientId: "p2" });
    expect(resolveRef("номер 1", two)).toMatchObject({ patientId: "p1" });
    expect(resolveRef("пятая", two)).toEqual({ kind: "choose", candidates: two.candidates });
  });

  it("«напиши» — не имя «Написат»: глагол из списка не выбирает", () => {
    const m = { focus: "p1", candidates: [{ id: "p1", name: "Ибрагимова Саида" }, { id: "p9", name: "Айдемирова Написат" }], lastText: null };
    expect(resolveRef("а ей напиши: врач задерживается", m)).toEqual({ kind: "patient", patientId: "p1", how: "pronoun" });
    expect(resolveRef("напиши: врач задерживается", { ...m, focus: null }).kind).toBe("none");
  });

  it("выбор фамилией из списка — только однозначный", () => {
    expect(resolveRef("Алиевой", two)).toEqual({ kind: "patient", patientId: "p1", how: "name" });
    expect(resolveRef("Диане", two).kind).not.toBe("patient");
  });

  it("«нет, другой» — второй из двух; из трёх — спросить", () => {
    expect(resolveRef("нет, другой", { ...two, focus: "p1" })).toEqual({ kind: "patient", patientId: "p2", how: "other" });
    const three = { ...two, focus: "p1", candidates: [...two.candidates, { id: "p3", name: "Омарова Диана" }] };
    expect(resolveRef("нет, другой", three)).toEqual({ kind: "choose", candidates: three.candidates.slice(1) });
  });

  it("«ей тоже» — повторить последнее письмо", () => {
    expect(asksSameAgain("и Патимат тоже")).toBe(true);
    expect(asksSameAgain("напиши то же самое Алиевой")).toBe(true);
    expect(asksSameAgain("что по ней?")).toBe(false);
  });

  it("порядковые", () => {
    expect(ordinalOf("Вторую")).toBe(1);
    expect(ordinalOf("а третья")).toBe(2);
    expect(ordinalOf("№ 4")).toBe(3);
    expect(ordinalOf("сколько стоит")).toBeNull();
  });

  it("память обновляется ответом и читается только своя", () => {
    const next = nextMemory(two, { focus: "p2" });
    expect(next).toEqual({ ...two, focus: "p2" });
    expect(memoryFrom({ focus: "p2", candidates: [{ id: "p1", name: "А" }, { bad: 1 }], lastText: "текст" })).toEqual({
      focus: "p2",
      candidates: [{ id: "p1", name: "А" }],
      lastText: "текст",
    });
    expect(memoryFrom(null)).toEqual(EMPTY_MEMORY);
  });
});
