import { describe, expect, it } from "vitest";
import { aliasesFromKnowledge, withStaffAliases } from "./staff-alias";

const ANSWERS = [
  "В Клинике доктора Алункачевой принимают два врача-остеопата 🌿\n☘️Алункачева Ирина Алилгаджиевна\n👩Взрослый приём — 8 000 ₽",
];
const STAFF = ["Ирина Алилгаджиевна", "Мугадова Разият Ризвановна", "Ирина Омарова"];

describe("фамилия врача из справочника", () => {
  it("находит фамилию перед полным именем", () => {
    expect(aliasesFromKnowledge(ANSWERS, STAFF)).toEqual([{ stem: "алункачев", name: "Ирина Алилгаджиевна" }]);
  });

  it("подсказывает имя рядом с фамилией в любом падеже", () => {
    const al = aliasesFromKnowledge(ANSWERS, STAFF);
    expect(withStaffAliases("хотела детей записать к Ирине Алункачевой", al)).toBe(
      "хотела детей записать к Ирине Алункачевой (Ирина Алилгаджиевна)",
    );
    expect(withStaffAliases("к Ирине Алилгаджиевне", al)).toBe("к Ирине Алилгаджиевне");
  });

  it("разные слова перед именем — не фамилия", () => {
    const two = [...ANSWERS, "Доктор Ирина Алилгаджиевна принимает"];
    expect(aliasesFromKnowledge(two, STAFF)).toEqual([]);
  });
});
