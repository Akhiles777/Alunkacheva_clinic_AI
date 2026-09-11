import { describe, expect, it } from "vitest";
import { idFromRoute, routePattern, screenLabel } from "./route-pattern";

describe("образец адреса", () => {
  it("обычный экран остаётся собой", () => {
    expect(routePattern("/inbox")).toBe("/inbox");
    expect(routePattern("/")).toBe("/");
  });

  it("идентификатор в адресе заменяется образцом", () => {
    expect(routePattern("/patients/cmtv9sg2r0000ze8o")).toBe("/patients/[id]");
    expect(routePattern("/settings/staff/abc123")).toBe("/settings/staff/[id]");
  });

  it("вложенный экран под идентификатором сохраняется", () => {
    expect(routePattern("/patients/abc123/courses")).toBe("/patients/[id]/courses");
  });

  /**
   * Главное правило: в параметрах живут идентификаторы пациентов и диалогов, а
   * иногда и поисковая строка, которую сотрудник набирал руками (§7).
   */
  it("параметры запроса не попадают в журнал", () => {
    expect(routePattern("/inbox?d=cmtv9sg2r0000ze8o")).toBe("/inbox");
    expect(routePattern("/patients?q=Магомедова")).toBe("/patients");
    expect(routePattern("/inbox#thread")).toBe("/inbox");
  });

  it("хвостовая косая не создаёт второй экран", () => {
    expect(routePattern("/inbox/")).toBe("/inbox");
    expect(routePattern("/")).toBe("/");
  });
});

describe("идентификатор из адреса", () => {
  it("берётся только у экранов, где он есть", () => {
    expect(idFromRoute("/patients/abc123")).toBe("abc123");
    expect(idFromRoute("/patients/abc123/courses")).toBe("abc123");
    expect(idFromRoute("/inbox")).toBeNull();
    expect(idFromRoute("/")).toBeNull();
  });

  it("из параметров запроса не берётся", () => {
    expect(idFromRoute("/patients?q=abc")).toBeNull();
  });
});

describe("подпись экрана", () => {
  it("известный экран называется по-русски", () => {
    expect(screenLabel("/inbox")).toBe("Диалоги");
    expect(screenLabel("/patients/[id]")).toBe("Карточка пациента");
  });

  it("незнакомый показывается как есть, а не прячется", () => {
    expect(screenLabel("/что-то-новое")).toBe("/что-то-новое");
  });
});
