import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  message: { findUnique: vi.fn(), update: vi.fn() },
  mediaFile: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
const fresh = vi.hoisted(() => ({ freshFileUrl: vi.fn() }));
vi.mock("@/lib/integrations/whatsapp/green-api", () => fresh);

const message = (url: string) => ({
  id: "m1",
  companyId: "c1",
  externalId: "ext1",
  attachments: [{ kind: "photo", mimeType: "image/jpeg", source: { provider: "WHATSAPP", url } }],
  conversation: { externalUserId: "79000000000@c.us" },
});

function respond(map: Record<string, { status: number; body?: string; size?: number }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const r = map[url] ?? { status: 404 };
      const headers = new Headers({ "content-type": "image/jpeg" });
      if (r.size) headers.set("content-length", String(r.size));
      return new Response(r.status < 400 ? (r.body ?? "jpeg") : null, { status: r.status, headers });
    }),
  );
}

beforeEach(async () => {
  process.env.MEDIA_DIR = await mkdtemp(path.join(tmpdir(), "media-"));
  vi.clearAllMocks();
  db.mediaFile.create.mockResolvedValue({ id: "mf1" });
});

describe("файлы пациента — у нас", () => {
  it("рабочая ссылка: файл сохранён, вложение ссылается на наш файл", async () => {
    db.message.findUnique.mockResolvedValue(message("https://p/ok"));
    respond({ "https://p/ok": { status: 200 } });
    const { cacheMessageAttachments } = await import("./remote-cache");
    expect(await cacheMessageAttachments("m1")).toBe(1);
    const saved = db.message.update.mock.calls[0][0].data.attachments[0];
    expect(saved.source).toMatchObject({ provider: "LOCAL", mediaId: "mf1", origin: "WHATSAPP" });
    expect(fresh.freshFileUrl).not.toHaveBeenCalled();
  });

  it("ссылка истекла — берём свежую у провайдера и сохраняем", async () => {
    db.message.findUnique.mockResolvedValue(message("https://p/old"));
    fresh.freshFileUrl.mockResolvedValue("https://p/new");
    respond({ "https://p/old": { status: 403 }, "https://p/new": { status: 200 } });
    const { cacheMessageAttachments } = await import("./remote-cache");
    expect(await cacheMessageAttachments("m1")).toBe(1);
    expect(fresh.freshFileUrl).toHaveBeenCalledWith("c1", "79000000000@c.us", "ext1");
  });

  it("у провайдера файла больше нет — ничего не пишем и не ломаемся", async () => {
    db.message.findUnique.mockResolvedValue(message("https://p/old"));
    fresh.freshFileUrl.mockResolvedValue(null);
    respond({ "https://p/old": { status: 404 } });
    const { cacheMessageAttachments } = await import("./remote-cache");
    expect(await cacheMessageAttachments("m1")).toBe(0);
    expect(db.message.update).not.toHaveBeenCalled();
  });

  it("файл больше предела — не тянем к себе", async () => {
    db.message.findUnique.mockResolvedValue(message("https://p/huge"));
    respond({ "https://p/huge": { status: 200, size: 200 * 1024 * 1024 } });
    const { cacheMessageAttachments } = await import("./remote-cache");
    expect(await cacheMessageAttachments("m1")).toBe(0);
  });
});
