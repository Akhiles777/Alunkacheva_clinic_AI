import { describe, expect, it } from "vitest";
import { requireId, requireIds } from "./require-id";

/**
 * В Prisma `where: { id: undefined }` не сужает выборку, а снимает условие:
 * `updateMany` меняет всё, до чего дотягивается остальная часть фильтра.
 * Выключение агента в одном диалоге так погасило его во всех.
 */
describe("идентификатор из внешнего вызова", () => {
  it("нормальный проходит", () => {
    expect(requireId("cln123", "диалог")).toBe("cln123");
  });

  it("отсутствующий — ошибка, а не тихая правка всего", () => {
    expect(() => requireId(undefined, "диалог")).toThrow(/все записи/);
    expect(() => requireId(null, "диалог")).toThrow();
    expect(() => requireId("", "диалог")).toThrow();
    expect(() => requireId("   ", "диалог")).toThrow();
  });

  it("не строка — тоже ошибка", () => {
    expect(() => requireId(42, "диалог")).toThrow();
    expect(() => requireId({}, "диалог")).toThrow();
  });

  it("список: пустой не фильтр", () => {
    expect(() => requireIds([], "диалоги")).toThrow(/все записи/);
    expect(requireIds(["a", "b"], "диалоги")).toEqual(["a", "b"]);
  });
});
