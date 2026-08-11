import { describe, expect, it } from "vitest";
import { personaFor } from "./personas";

/**
 * Ассистент был один на всех: врачу и администратору отвечал бизнес-аналитик
 * владельца. Роль должна менять зону внимания, а отсутствие права на выручку —
 * закрывать разговор о деньгах.
 */
describe("personaFor", () => {
  it("у каждой роли своя зона", () => {
    expect(personaFor("OWNER", true)).toContain("бизнес-аналитик владельца");
    expect(personaFor("MANAGER", true)).toContain("управляющего");
    expect(personaFor("ADMIN", true)).toContain("администратора");
    expect(personaFor("DOCTOR", true)).toContain("специалиста");
  });

  it("общие запреты стоят у всех", () => {
    for (const role of ["OWNER", "MANAGER", "ADMIN", "DOCTOR"] as const) {
      const p = personaFor(role, true);
      expect(p, role).toContain("ТОЛЬКО НА ЧТЕНИЕ");
      expect(p, role).toContain("Не давай медицинских советов");
    }
  });

  it("без права на выручку деньги обсуждать запрещено", () => {
    expect(personaFor("ADMIN", false)).toContain("Суммы, выручку и средний чек не называй");
    expect(personaFor("ADMIN", true)).not.toContain("Суммы, выручку и средний чек не называй");
  });

  it("врач не обсуждает деньги и работу коллег даже с правом", () => {
    expect(personaFor("DOCTOR", true)).toContain("Не обсуждай деньги");
  });
});
