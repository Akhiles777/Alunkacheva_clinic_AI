import { describe, expect, it } from "vitest";
import { idsToDelete } from "./list-save";

/**
 * Сохранение раздела настроек целиком. Перед подключением YCLIENTS это
 * критично: импорт заводит услуги и специалистов, и сохранение со страницы,
 * открытой до импорта, снесло бы их все.
 */
describe("idsToDelete", () => {
  it("удаляет то, что человек убрал с экрана", () => {
    expect(idsToDelete({ existing: ["a", "b", "c"], submitted: ["a", "c"], known: ["a", "b", "c"] })).toEqual(["b"]);
  });

  it("не трогает строки, появившиеся после загрузки страницы", () => {
    // «imported» приехал из YCLIENTS уже после того, как экран загрузился.
    expect(
      idsToDelete({ existing: ["a", "imported"], submitted: ["a"], known: ["a"] }),
    ).toEqual([]);
  });

  it("одновременно: своё удаляет, чужое сохраняет", () => {
    expect(
      idsToDelete({ existing: ["a", "b", "imported"], submitted: ["a"], known: ["a", "b"] }),
    ).toEqual(["b"]);
  });

  it("без сведений о загруженном ведёт себя по-старому", () => {
    expect(idsToDelete({ existing: ["a", "b"], submitted: ["a"] })).toEqual(["b"]);
    expect(idsToDelete({ existing: ["a", "b"], submitted: ["a"], known: [] })).toEqual(["b"]);
  });

  it("ничего не убрали — нечего удалять", () => {
    expect(idsToDelete({ existing: ["a", "b"], submitted: ["a", "b"], known: ["a", "b"] })).toEqual([]);
  });
})
