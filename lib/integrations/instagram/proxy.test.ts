import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graphUrl, proxyWebhookUrl } from "./config";
import { describeProxyFailure, graphRequest, type FetchLike } from "./graph";
import {
  FAILURES_BEFORE_ALERT,
  INITIAL_WATCH,
  checkProxy,
  nextWatch,
  reasonOf,
  type ProxyCheck,
} from "./proxy-health";

/**
 * Связь с Instagram через прокси на Vercel: что уходит, как узнаём, чей
 * ответ, и что происходит, когда прокси лежит.
 */

const BASE = "https://ig-proxy.test/api/graph";

beforeEach(() => {
  process.env.INSTAGRAM_GRAPH_BASE = BASE;
  process.env.INSTAGRAM_PROXY_SECRET = "s3cret";
});

afterEach(() => {
  delete process.env.INSTAGRAM_GRAPH_BASE;
  delete process.env.INSTAGRAM_PROXY_SECRET;
});

function net(reply: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return reply(url, init);
  };
  return { impl, calls };
}

const down: FetchLike = async () => {
  throw new TypeError("fetch failed");
};

describe("адрес Instagram API", () => {
  it("строится только из INSTAGRAM_GRAPH_BASE — адреса Meta в коде нет", () => {
    expect(graphUrl("me/messages")).toBe(`${BASE}/v21.0/me/messages`);
    delete process.env.INSTAGRAM_GRAPH_BASE;
    expect(graphUrl("me/messages")).toBeNull();
  });

  it("адрес вебхука для Meta — на прокси", () => {
    expect(proxyWebhookUrl()).toBe("https://ig-proxy.test/api/webhook");
    process.env.INSTAGRAM_GRAPH_BASE = "https://graph.instagram.com";
    expect(proxyWebhookUrl()).toBeNull();
  });
});

describe("запрос к Meta через прокси", () => {
  it("несёт секрет прокси, токен — заголовком, а не в адресе", async () => {
    const n = net(() => new Response('{"message_id":"m1"}', { status: 200 }));
    const out = await graphRequest({
      path: "me/messages",
      method: "POST",
      token: "tok",
      body: { a: 1 },
      fetchImpl: n.impl,
    });
    expect(out.kind).toBe("ok");
    const headers = new Headers(n.calls[0].init?.headers);
    expect(headers.get("x-proxy-secret")).toBe("s3cret");
    expect(headers.get("authorization")).toBe("Bearer tok");
    // Адреса пишет журнал Vercel: токену там не место.
    expect(n.calls[0].url).not.toContain("tok");
  });

  it("без секрета прокси запрос не уходит вовсе", async () => {
    delete process.env.INSTAGRAM_PROXY_SECRET;
    const n = net(() => new Response("{}"));
    const out = await graphRequest({ path: "me", fetchImpl: n.impl });
    expect(out).toEqual({
      kind: "not_configured",
      what: "INSTAGRAM_PROXY_SECRET",
    });
    expect(n.calls).toHaveLength(0);
  });

  it("ошибка Meta — это ответ Meta, а не сбой прокси", async () => {
    const n = net(
      () => new Response('{"error":{"code":190}}', { status: 400 }),
    );
    const out = await graphRequest({ path: "me", fetchImpl: n.impl });
    expect(out.kind).toBe("meta_error");
    expect(describeProxyFailure(out)).toBeNull();
  });

  it("отказ самого прокси узнаётся по его метке", async () => {
    const n = net(
      () =>
        new Response('{"error":"forbidden"}', {
          status: 403,
          headers: { "x-ig-proxy": "forbidden" },
        }),
    );
    const out = await graphRequest({ path: "me", fetchImpl: n.impl });
    expect(out.kind).toBe("proxy_error");
    expect(describeProxyFailure(out)).toContain("секрет прокси");
  });

  it("страница ошибки Vercel вместо JSON — сбой прокси, а не ответ Meta", async () => {
    const n = net(
      () => new Response("<html>502 BAD_GATEWAY</html>", { status: 502 }),
    );
    const out = await graphRequest({ path: "me", fetchImpl: n.impl });
    expect(out.kind).toBe("proxy_error");
  });
});

describe("прокси недоступен", () => {
  it("отправка называет причину словами и не притворяется, что ушло", async () => {
    const out = await graphRequest({
      path: "me/messages",
      method: "POST",
      token: "t",
      body: {},
      fetchImpl: down,
    });
    expect(out).toEqual({ kind: "network", timeout: false });
    expect(describeProxyFailure(out)).toBe(
      "Прокси Instagram недоступен — нет связи с Vercel.",
    );
  });

  it("проверка связи не проходит в обе стороны", async () => {
    const check = await checkProxy(down);
    expect(check.ok).toBe(false);
    expect(check.outbound).toContain("недоступен");
    expect(check.inbound).toContain("недоступен");
  });

  it("прокси жив, но не достаёт до сервера клиники — это видно отдельно", async () => {
    const n = net((url) =>
      url.includes("/api/webhook")
        ? new Response('{"error":"origin unreachable"}', {
            status: 502,
            headers: { "x-ig-proxy": "origin unreachable" },
          })
        : new Response('{"error":{"type":"OAuthException"}}', { status: 400 }),
    );
    const check = await checkProxy(n.impl);
    expect(check.outbound).toBeNull();
    expect(check.inbound).toContain("не достучался до сервера клиники");
  });

  it("всё в порядке: Meta ответила (хоть и отказом без токена), вебхук ответил pong", async () => {
    const n = net((url) =>
      url.includes("/api/webhook?hub.mode=ping")
        ? new Response("pong", { status: 200 })
        : new Response('{"error":{"type":"OAuthException"}}', { status: 400 }),
    );
    const check = await checkProxy(n.impl);
    expect(check).toMatchObject({ ok: true, outbound: null, inbound: null });
    // Токен в фоновую проверку не кладётся.
    const graphCall = n.calls.find((c) => c.url.includes("/api/graph/"));
    expect(
      new Headers(graphCall?.init?.headers).get("authorization"),
    ).toBeNull();
  });
});

describe("уведомления о сбое прокси", () => {
  const bad: ProxyCheck = {
    ok: false,
    outbound: "x",
    inbound: null,
    checkedAt: "",
  };
  const good: ProxyCheck = {
    ok: true,
    outbound: null,
    inbound: null,
    checkedAt: "",
  };

  it("одна неудача — не повод будить людей, две подряд — повод", () => {
    let s = INITIAL_WATCH;
    const alerts: (string | null)[] = [];
    for (let i = 0; i < FAILURES_BEFORE_ALERT + 3; i += 1) {
      const r = nextWatch(s, bad);
      s = r.state;
      alerts.push(r.alert);
    }
    expect(alerts.filter((a) => a === "down")).toHaveLength(1);
    expect(alerts[FAILURES_BEFORE_ALERT - 1]).toBe("down");
  });

  it("восстановление — одно уведомление, и только после сообщения о сбое", () => {
    expect(nextWatch(INITIAL_WATCH, good).alert).toBeNull();
    const blip = nextWatch(INITIAL_WATCH, bad).state;
    expect(nextWatch(blip, good).alert).toBeNull();

    let s = INITIAL_WATCH;
    for (let i = 0; i < FAILURES_BEFORE_ALERT; i += 1)
      s = nextWatch(s, bad).state;
    const back = nextWatch(s, good);
    expect(back.alert).toBe("recovered");
    expect(nextWatch(back.state, good).alert).toBeNull();
  });
});

describe("причина сбоя словами", () => {
  it("одинаковая причина с обеих сторон не повторяется", () => {
    expect(
      reasonOf({ ok: false, outbound: "A", inbound: "A", checkedAt: "" }),
    ).toBe("A");
    expect(
      reasonOf({ ok: false, outbound: "A", inbound: "B", checkedAt: "" }),
    ).toBe("A B");
  });
});
