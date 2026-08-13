import { describe, expect, it } from "vitest";
import { mergeKeepingOrder } from "./merge-list";

/**
 * После сохранения список заменялся ответом сервера, а тот отдаёт записи по
 * алфавиту: добавленная в конец строка уезжала в середину шести десятков
 * других, и человек считал, что она потерялась.
 */
interface Row { id: string; topic: string; answer: string }
const key = (r: Row) => r.topic.toLowerCase();

describe("mergeKeepingOrder", () => {
  it("новая запись остаётся там, куда её добавили", () => {
    const current: Row[] = [
      { id: "1", topic: "Адрес", answer: "" },
      { id: "2", topic: "Цены", answer: "" },
      { id: "tmp", topic: "Яблоко", answer: "черновик" },
    ];
    // Сервер вернул по алфавиту и выдал настоящий идентификатор.
    const saved: Row[] = [
      { id: "1", topic: "Адрес", answer: "" },
      { id: "3", topic: "Яблоко", answer: "черновик" },
      { id: "2", topic: "Цены", answer: "" },
    ];
    const merged = mergeKeepingOrder(current, saved, key);
    expect(merged.map((r) => r.topic)).toEqual(["Адрес", "Цены", "Яблоко"]);
    // Идентификатор подхватился с сервера — иначе следующее сохранение
    // завело бы копию.
    expect(merged[2].id).toBe("3");
  });

  it("чужие записи дописываются в конец, а не теряются", () => {
    const current: Row[] = [{ id: "1", topic: "Адрес", answer: "" }];
    const saved: Row[] = [
      { id: "1", topic: "Адрес", answer: "" },
      { id: "9", topic: "Заведено коллегой", answer: "" },
    ];
    expect(mergeKeepingOrder(current, saved, key).map((r) => r.topic)).toEqual([
      "Адрес",
      "Заведено коллегой",
    ]);
  });

  it("содержимое берётся с сервера, порядок — с экрана", () => {
    const current: Row[] = [
      { id: "1", topic: "Б", answer: "старое" },
      { id: "2", topic: "А", answer: "старое" },
    ];
    const saved: Row[] = [
      { id: "2", topic: "А", answer: "новое" },
      { id: "1", topic: "Б", answer: "новое" },
    ];
    const merged = mergeKeepingOrder(current, saved, key);
    expect(merged.map((r) => r.topic)).toEqual(["Б", "А"]);
    expect(merged.every((r) => r.answer === "новое")).toBe(true);
  });

  it("строка, которой нет в ответе, остаётся на экране", () => {
    const current: Row[] = [
      { id: "1", topic: "Адрес", answer: "" },
      { id: "2", topic: "Не отправляли", answer: "" },
    ];
    const saved: Row[] = [{ id: "1", topic: "Адрес", answer: "" }];
    expect(mergeKeepingOrder(current, saved, key)).toHaveLength(2);
  });

  it("пустые списки не ломают слияние", () => {
    expect(mergeKeepingOrder<Row>([], [], key)).toEqual([]);
  });
});
