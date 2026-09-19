import {
  PROXY_OWN_HEADER,
  PROXY_SECRET_HEADER,
  graphUrl,
  proxySecret,
} from "./config";

/**
 * Один запрос к Instagram API — через наш прокси.
 *
 * Здесь решается, ЧЕЙ ответ пришёл, потому что поломки бывают трёх сортов и
 * чинятся в трёх разных местах:
 *   - прокси недоступен или отказал (секрет, настройки) — Vercel и .env;
 *   - Meta ответила ошибкой (токен, окно 24 часа) — кабинет Meta и «Интеграции»;
 *   - не настроено у нас — переменные окружения.
 * Свалить их в одно «нет связи с Instagram» значит отправить человека чинить
 * не то.
 *
 * Токен страницы идёт заголовком Authorization, а не в адресе: адреса запросов
 * пишет журнал Vercel, и токен в query лёг бы в чужие логи.
 */

export type GraphOutcome =
  | { kind: "ok"; status: number; raw: string }
  | { kind: "meta_error"; status: number; raw: string }
  | { kind: "proxy_error"; status: number; reason: string }
  | { kind: "network"; timeout: boolean }
  | { kind: "not_configured"; what: string };

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface GraphRequest {
  path: string;
  method?: "GET" | "POST" | "DELETE";
  token?: string | null;
  body?: unknown;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export async function graphRequest(req: GraphRequest): Promise<GraphOutcome> {
  const url = graphUrl(req.path);
  if (!url) return { kind: "not_configured", what: "INSTAGRAM_GRAPH_BASE" };
  const secret = proxySecret();
  if (!secret)
    return { kind: "not_configured", what: "INSTAGRAM_PROXY_SECRET" };

  const headers: Record<string, string> = { [PROXY_SECRET_HEADER]: secret };
  if (req.token) headers.Authorization = `Bearer ${req.token}`;
  if (req.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await (req.fetchImpl ?? fetch)(url, {
      method: req.method ?? "GET",
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(req.timeoutMs ?? 20_000),
    });
  } catch (e) {
    const name = (e as Error)?.name;
    return {
      kind: "network",
      timeout: name === "TimeoutError" || name === "AbortError",
    };
  }

  const own = res.headers.get(PROXY_OWN_HEADER);
  if (own) {
    await res.body?.cancel().catch(() => {});
    return { kind: "proxy_error", status: res.status, reason: own };
  }

  const raw = await res.text().catch(() => "");
  /**
   * Ответ Meta всегда JSON. HTML или пустота с кодом 5xx — это Vercel или
   * что-то перед ним, а не Meta: так отвечает упавший или не развёрнутый
   * прокси («404: NOT_FOUND», страница ошибки платформы).
   */
  if (!res.ok && !looksLikeMeta(raw)) {
    return {
      kind: "proxy_error",
      status: res.status,
      reason: `ответ не от Meta (${res.status})`,
    };
  }
  return res.ok
    ? { kind: "ok", status: res.status, raw }
    : { kind: "meta_error", status: res.status, raw };
}

function looksLikeMeta(raw: string): boolean {
  try {
    const json = JSON.parse(raw) as { error?: unknown };
    return typeof json === "object" && json !== null && "error" in json;
  } catch {
    return false;
  }
}

/** Причина словами — для администратора и для журнала. */
export function describeProxyFailure(o: GraphOutcome): string | null {
  switch (o.kind) {
    case "not_configured":
      return `Не задан ${o.what} на сервере — запросы к Instagram идти некуда.`;
    case "network":
      return o.timeout
        ? "Прокси Instagram не ответил вовремя."
        : "Прокси Instagram недоступен — нет связи с Vercel.";
    case "proxy_error":
      if (o.status === 403)
        return "Прокси Instagram отказал: секрет прокси не совпадает с нашим.";
      if (o.reason === "proxy not configured")
        return "Прокси Instagram не настроен (ORIGIN_URL, PROXY_SECRET на Vercel).";
      if (o.reason === "graph unreachable")
        return "Прокси работает, но сам не дотянулся до Instagram.";
      return `Прокси Instagram ответил ошибкой: ${o.reason}.`;
    default:
      return null;
  }
}
