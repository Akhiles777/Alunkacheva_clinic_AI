import { describe, expect, it } from "vitest";
import {
  needsReview,
  parseVerdict,
  sampleRuns,
  SAMPLE_LIMIT,
  type RunForSample,
} from "./quality-sample";

const run = (p: Partial<RunForSample> = {}): RunForSample => ({
  id: "r1",
  medical: false,
  reasked: false,
  escalated: false,
  knowledgeEntryIds: ["k1"],
  checked: false,
  deleted: false,
  ...p,
});

describe("выборка ответов на проверку", () => {
  it("медицинские берём все", () => {
    const runs = [
      run({ id: "m1", medical: true }),
      run({ id: "m2", medical: true }),
      run({ id: "ok" }),
    ];
    const picked = sampleRuns(runs, 10, () => false);
    expect(picked.filter((p) => p.reason === "medical").map((p) => p.runId)).toEqual(["m1", "m2"]);
  });

  it("ответ без записи справочника попадает как «сказал от себя»", () => {
    const picked = sampleRuns([run({ id: "u1", knowledgeEntryIds: [] })], 10, () => false);
    expect(picked).toEqual([{ runId: "u1", reason: "ungrounded" }]);
  });

  it("переспросили или завелась эскалация — берём", () => {
    const picked = sampleRuns(
      [run({ id: "a", reasked: true }), run({ id: "b", escalated: true })],
      10,
      () => false,
    );
    expect(picked.map((p) => p.reason).sort()).toEqual(["escalated", "reasked"]);
  });

  it("уже проверенные и удалённые не берём", () => {
    const picked = sampleRuns(
      [run({ id: "c", medical: true, checked: true }), run({ id: "d", medical: true, deleted: true })],
      10,
      () => false,
    );
    expect(picked).toEqual([]);
  });

  it("один ответ не попадает в выборку дважды", () => {
    const picked = sampleRuns([run({ id: "x", medical: true, escalated: true, reasked: true })], 10, () => false);
    expect(picked).toEqual([{ runId: "x", reason: "medical" }]);
  });

  it("случайная выборка добирает остаток и не превышает предел", () => {
    const runs = Array.from({ length: 100 }, (_, i) => run({ id: `r${i}` }));
    const picked = sampleRuns(runs, SAMPLE_LIMIT, () => true);
    expect(picked.length).toBe(SAMPLE_LIMIT);
  });

  it("предел соблюдается даже если медицинских больше него", () => {
    const runs = Array.from({ length: 60 }, (_, i) => run({ id: `m${i}`, medical: true }));
    expect(sampleRuns(runs, 10).length).toBe(10);
  });
});

describe("разбор вердикта", () => {
  it("узнаёт вердикт и комментарий", () => {
    expect(parseVerdict("DEVIATION: назвал цену, которой нет в прайсе")).toEqual({
      verdict: "DEVIATION",
      comment: "назвал цену, которой нет в прайсе",
    });
    expect(parseVerdict("ok — всё по справке")?.verdict).toBe("OK");
  });

  it("вердикт без пояснения принимается, слово с ним схожее — нет", () => {
    // Модель иногда отвечает одним словом; это полноценный вердикт.
    expect(parseVerdict("OK")).toEqual({ verdict: "OK", comment: "" });
    // А «OKAY, всё хорошо» — уже не вердикт, и молча читать его как OK нельзя.
    expect(parseVerdict("OKAY, всё хорошо")).toBeNull();
  });

  it("непонятный ответ не считается «всё хорошо»", () => {
    expect(parseVerdict("кажется, всё нормально")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });

  it("человеку показываем всё, кроме OK", () => {
    expect(needsReview("OK")).toBe(false);
    expect(needsReview("MEDICAL_WITHOUT_SOURCE")).toBe(true);
  });
});
