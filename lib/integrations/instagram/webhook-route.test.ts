import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Вебхук Instagram целиком: пускает только наш прокси, и только потом —
 * прежние проверки Meta (слово проверки, подпись). База и агент подменены:
 * здесь проверяются ворота, а не разбор сообщения.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    message: { findFirst: vi.fn(async () => null) },
    conversation: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/agent/clinic-agent", () => ({
  handlePatientMessage: vi.fn(async () => null),
}));
vi.mock("@/lib/agent/unanswered", () => ({
  markDelivery: vi.fn(async () => {}),
}));
vi.mock("./credentials", () => ({
  resolveInstagramCompany: vi.fn(async () => "company-1"),
  instagramKey: vi.fn(async (_c: string, key: string) =>
    key === "verify_token"
      ? "проверка"
      : key === "app_secret"
        ? "секрет-приложения"
        : null,
  ),
}));

const { GET, POST } = await import("@/app/api/webhooks/instagram/route");

const verifyUrl = (token: string, extra = "") =>
  `https://clinic.test/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=777${extra}`;

function signed(body: string, secret = "секрет-приложения") {
  return `sha256=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

beforeEach(() => {
  process.env.INSTAGRAM_PROXY_SECRET = "s3cret";
  process.env.INSTAGRAM_ENABLED = "true";
});

afterEach(() => {
  delete process.env.INSTAGRAM_PROXY_SECRET;
  delete process.env.INSTAGRAM_ENABLED;
});

describe("верификация вебхука через прокси", () => {
  it("с секретом прокси и верным словом — challenge голой строкой", async () => {
    const res = await GET(
      new Request(verifyUrl("проверка"), {
        headers: { "x-proxy-secret": "s3cret" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("777");
  });

  it("верное слово, но без секрета прокси — 403", async () => {
    const res = await GET(new Request(verifyUrl("проверка")));
    expect(res.status).toBe(403);
  });

  it("секрет прокси есть, слово чужое — 403", async () => {
    const res = await GET(
      new Request(verifyUrl("чужое"), {
        headers: { "x-proxy-secret": "s3cret" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("проверка связи отвечает pong только нашему прокси", async () => {
    const ping = "https://clinic.test/api/webhooks/instagram?hub.mode=ping";
    const ok = await GET(
      new Request(ping, { headers: { "x-proxy-secret": "s3cret" } }),
    );
    expect(await ok.text()).toBe("pong");
    expect((await GET(new Request(ping))).status).toBe(403);
  });
});

describe("события без X-Proxy-Secret отбрасываются", () => {
  const body = '{"object":"instagram","entry":[]}';

  it("даже с верной подписью Meta — 403", async () => {
    const res = await POST(
      new Request("https://clinic.test/api/webhooks/instagram", {
        method: "POST",
        body,
        headers: { "x-hub-signature-256": signed(body) },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("с чужим секретом — 403", async () => {
    const res = await POST(
      new Request("https://clinic.test/api/webhooks/instagram", {
        method: "POST",
        body,
        headers: {
          "x-proxy-secret": "guess",
          "x-hub-signature-256": signed(body),
        },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("секрет не задан у нас — не принимаем никого", async () => {
    delete process.env.INSTAGRAM_PROXY_SECRET;
    const res = await POST(
      new Request("https://clinic.test/api/webhooks/instagram", {
        method: "POST",
        body,
        headers: { "x-proxy-secret": "", "x-hub-signature-256": signed(body) },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("секрет прокси верный, подпись Meta чужая — 401: одно другого не заменяет", async () => {
    const res = await POST(
      new Request("https://clinic.test/api/webhooks/instagram", {
        method: "POST",
        body,
        headers: {
          "x-proxy-secret": "s3cret",
          "x-hub-signature-256": signed(body, "другой"),
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("секрет прокси и подпись верны — событие принято", async () => {
    const res = await POST(
      new Request("https://clinic.test/api/webhooks/instagram", {
        method: "POST",
        body,
        headers: {
          "x-proxy-secret": "s3cret",
          "x-hub-signature-256": signed(body),
        },
      }),
    );
    expect(res.status).toBe(200);
  });
});
