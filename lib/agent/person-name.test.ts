import { describe, expect, it } from "vitest";
import { addressableName } from "./person-name";

describe("имя для обращения из профиля мессенджера", () => {
  it("ник — не имя: «amikomiko» и подобные не берём", () => {
    for (const raw of ["amikomiko", "zarema_1985", "Zarema1985", "🌸", "мама Амины", "Мама Амины", "@patimat", ""]) {
      expect(addressableName(raw), raw).toBeNull();
    }
  });

  it("имя с заглавной — берём, эмодзи снимаем", () => {
    expect(addressableName("Патимат")).toBe("Патимат");
    expect(addressableName("Зарема 💕")).toBe("Зарема");
    expect(addressableName("Patimat")).toBe("Patimat");
    expect(addressableName("Анна-Мария")).toBe("Анна-Мария");
    expect(addressableName("Марьям Магомедова")).toBe("Марьям Магомедова");
  });
});
