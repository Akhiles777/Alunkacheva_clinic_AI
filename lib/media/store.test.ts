import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "media-"));
  process.env.MEDIA_DIR = dir;
});

async function* chunks(...parts: string[]) {
  for (const p of parts) yield new TextEncoder().encode(p);
}

describe("saveStream", () => {
  it("пишет потоком и отдаёт тот же файл", async () => {
    const { saveStream, pathOf } = await import("./store");
    const saved = await saveStream(chunks("привет, ", "мир"));
    expect(await readFile(pathOf(saved.id), "utf8")).toBe("привет, мир");
    expect(saved.sizeBytes).toBe(Buffer.byteLength("привет, мир"));
  });

  it("сверх предела — отказ, и недописанный файл не остаётся", async () => {
    const { saveStream } = await import("./store");
    await expect(saveStream(chunks("1234", "5678"), 5)).rejects.toThrow(/больше допустимого/);
    const all = (await readdir(dir, { recursive: true })).map(String);
    expect(all.some((f) => f.endsWith(".part"))).toBe(false);
  });

  it("пустой файл — отказ", async () => {
    const { saveStream } = await import("./store");
    await expect(saveStream(chunks())).rejects.toThrow(/пустой/);
  });
});
