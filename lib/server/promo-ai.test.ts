import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Разбор переписки акции — отдельная очередь, НЕ путь пациентского агента:
 * он не пишет ни в переписку, ни в сообщения, ни в статус и паузу диалога.
 * Проверяем по исходнику: правка, которая это нарушит, должна упасть здесь.
 */
describe("разбор переписки акции ничего не трогает в диалоге", () => {
  const src = readFileSync(new URL("./promo-ai.ts", import.meta.url), "utf8");
  it.each([
    /conversation\.(?:update|updateMany|create|upsert|delete)/,
    /message\.(?:update|updateMany|create|upsert|delete)/,
    /botPausedUntil/,
    /HUMAN_TAKEOVER/,
    /dialogNote/,
    /escalate\(/,
    /sendMessage|startDialog|respond\(/,
  ])("в исходнике нет %s", (re) => {
    expect(src).not.toMatch(re);
  });
  it("привязка по улике создаётся только «на проверке»; подтверждает и отклоняет только человек", () => {
    expect(src).toMatch(/reviewStatus: "REVIEW"/);
    // «CONFIRMED» встречается только в условиях выборки, никогда — в записываемых данных.
    for (const line of src.split("\n").filter((l) => l.includes('reviewStatus: "CONFIRMED"'))) expect(line).toMatch(/where:/);
    expect(src).not.toMatch(/reviewStatus: "REJECTED"/);
    expect(src).not.toMatch(/removedAt: new Date|partnerAttribution\.delete/);
  });
});
