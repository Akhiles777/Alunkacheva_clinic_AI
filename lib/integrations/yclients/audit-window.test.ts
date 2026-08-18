import { describe, expect, it } from "vitest";
import { auditWindow } from "./sync";

/**
 * Перенос записи в другой месяц — главный источник дублей, которых в YCLIENTS
 * нет. Обычная выгрузка перечитывает последний месяц, поэтому старая копия в
 * июне остаётся навсегда. Ротация проверяет по месяцу истории каждый час: за
 * сутки обходятся два года, и полная выгрузка руками больше не нужна.
 */
describe("ротация проверки истории", () => {
  it("окно — ровно один календарный месяц", () => {
    const w = auditWindow(new Date("2026-08-18T10:00:00Z"));
    expect(w).not.toBeNull();
    const months =
      (w!.to.getUTCFullYear() - w!.from.getUTCFullYear()) * 12 +
      (w!.to.getUTCMonth() - w!.from.getUTCMonth());
    expect(months).toBe(1);
    expect(w!.from.getUTCDate()).toBe(1);
  });

  it("месяц всегда в прошлом", () => {
    const now = new Date("2026-08-18T10:00:00Z");
    for (let h = 0; h < 48; h++) {
      const at = new Date(now.getTime() + h * 3600_000);
      const w = auditWindow(at);
      if (w) expect(w.to.getTime()).toBeLessThanOrEqual(at.getTime());
    }
  });

  it("за сутки обходит разные месяцы, а не топчется на одном", () => {
    const now = new Date("2026-08-18T00:00:00Z");
    const seen = new Set<string>();
    for (let h = 0; h < 24; h++) {
      const w = auditWindow(new Date(now.getTime() + h * 3600_000));
      if (w) seen.add(w.from.toISOString());
    }
    expect(seen.size).toBeGreaterThan(12);
  });

  it("месяц, который и так перечитывается, пропускаем", () => {
    // notBefore — начало обычного окна выгрузки. Второй раз читать незачем.
    const now = new Date("2026-08-18T10:00:00Z");
    const w = auditWindow(now, new Date("2020-01-01T00:00:00Z"));
    expect(w).toBeNull();
  });
});
