import { describe, expect, it } from "vitest";
import { hotkeyAction, nextWaiting, step } from "./hotkeys";

describe("горячие клавиши инбокса", () => {
  it("во время набора буквы не переключают диалог", () => {
    expect(hotkeyAction({ key: "u", typing: true })).toBeNull();
    expect(hotkeyAction({ key: "j", typing: true })).toBeNull();
    expect(hotkeyAction({ key: "?", typing: true })).toBeNull();
  });

  it("во время набора работают только отправка и выход", () => {
    expect(hotkeyAction({ key: "Enter", metaKey: true, typing: true })).toBe("send");
    expect(hotkeyAction({ key: "Escape", typing: true })).toBe("escape");
  });

  it("вне поля ввода ходим стрелками и буквами", () => {
    expect(hotkeyAction({ key: "ArrowDown", typing: false })).toBe("next");
    expect(hotkeyAction({ key: "k", typing: false })).toBe("prev");
    expect(hotkeyAction({ key: "u", typing: false })).toBe("nextWaiting");
    expect(hotkeyAction({ key: "?", typing: false })).toBe("help");
  });

  it("⌘K остаётся глобальному поиску, а не инбоксу", () => {
    expect(hotkeyAction({ key: "k", metaKey: true, typing: false })).toBeNull();
  });

  it("Alt-сочетания не трогаем: это ввод символов", () => {
    expect(hotkeyAction({ key: "j", altKey: true, typing: false })).toBeNull();
  });
});

describe("переход по списку", () => {
  const ids = ["a", "b", "c"];

  it("вниз и вверх по кругу", () => {
    expect(step(ids, "a", 1)).toBe("b");
    expect(step(ids, "c", 1)).toBe("a");
    expect(step(ids, "a", -1)).toBe("c");
  });

  it("ничего не выбрано — берём край", () => {
    expect(step(ids, null, 1)).toBe("a");
    expect(step(ids, null, -1)).toBe("c");
    expect(step([], null, 1)).toBeNull();
  });

  it("выбранного нет в списке (сменили фильтр) — идём с края", () => {
    expect(step(ids, "z", 1)).toBe("a");
  });
});

describe("следующий, кто ждёт", () => {
  const rows = [
    { id: "a", waiting: false },
    { id: "b", waiting: true },
    { id: "c", waiting: false },
    { id: "d", waiting: true },
  ];

  it("идёт от текущего дальше, а не с начала", () => {
    expect(nextWaiting(rows, "b")).toBe("d");
    expect(nextWaiting(rows, "d")).toBe("b");
  });

  it("ничего не выбрано — первый ждущий", () => {
    expect(nextWaiting(rows, null)).toBe("b");
  });

  it("ждущих нет — некуда идти", () => {
    expect(nextWaiting([{ id: "a", waiting: false }], "a")).toBeNull();
  });
});
