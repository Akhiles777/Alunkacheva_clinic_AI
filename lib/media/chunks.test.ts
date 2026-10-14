import { describe, expect, it } from "vitest";
import { CHUNK_BYTES, MAX_UPLOAD_BYTES, chunkPlan, sliceFile, uploadErrorText } from "./chunks";

describe("загрузка частями", () => {
  const ok = { uploadId: "lq3x9-abc12345", index: 0, total: 3, size: CHUNK_BYTES * 2 + 10, chunkBytes: CHUNK_BYTES };

  it("часть меньше предела nginx по умолчанию (1 МБ)", () => {
    expect(CHUNK_BYTES).toBeLessThan(1024 * 1024 - 64 * 1024);
  });

  it("нарезка покрывает файл целиком и без пересечений", () => {
    const parts = sliceFile(CHUNK_BYTES * 2 + 10);
    expect(parts).toEqual([
      { start: 0, end: CHUNK_BYTES },
      { start: CHUNK_BYTES, end: CHUNK_BYTES * 2 },
      { start: CHUNK_BYTES * 2, end: CHUNK_BYTES * 2 + 10 },
    ]);
  });

  it("принимает правильную часть", () => {
    expect(chunkPlan(ok)).toMatchObject({ ok: true, total: 3 });
  });

  it("путь на диске не собрать из чужого идентификатора", () => {
    expect(chunkPlan({ ...ok, uploadId: "../../etc" }).ok).toBe(false);
  });

  it("лишняя часть, большой файл, большая часть, несходящееся число частей — отказ", () => {
    expect(chunkPlan({ ...ok, index: 3 }).ok).toBe(false);
    expect(chunkPlan({ ...ok, size: MAX_UPLOAD_BYTES + 1, total: Math.ceil((MAX_UPLOAD_BYTES + 1) / CHUNK_BYTES) }).ok).toBe(false);
    expect(chunkPlan({ ...ok, chunkBytes: CHUNK_BYTES + 1 }).ok).toBe(false);
    expect(chunkPlan({ ...ok, total: 5 }).ok).toBe(false);
  });

  it("ответ не в JSON объясняется словами, а не «проверьте связь»", () => {
    expect(uploadErrorText(413)).toMatch(/предел размера/);
    expect(uploadErrorText(401)).toMatch(/войдите/);
  });
});
