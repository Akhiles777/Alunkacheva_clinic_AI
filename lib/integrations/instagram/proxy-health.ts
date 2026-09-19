import { PROXY_OWN_HEADER, proxyWebhookUrl } from "./config";
import { describeProxyFailure, graphRequest, type FetchLike } from "./graph";
import { PING_REPLY } from "./webhook";

/**
 * Жив ли прокси Instagram — обе стороны цепочки.
 *
 * Прокси — новая точка отказа, и упавший прокси выглядит ровно так же, как
 * «сегодня никто не написал»: входящих нет, ошибок нет. Поэтому проверяем
 * его сами, и в обе стороны, потому что ломаются они порознь:
 *
 *   исходящее  мы → прокси → graph.instagram.com. Без токена: Meta отвечает
 *              ошибкой авторизации, и это ответ Meta — значит путь есть.
 *              Токен в проверку не кладём: ему нечего делать в фоновом запросе.
 *   входящее   мы → прокси → мы (`?hub.mode=ping`). Тот же путь, которым идут
 *              события Meta, от Vercel до сервера клиники, с секретом прокси.
 *
 * Ничего не пишет и никого не уведомляет: это делает планировщик
 * (lib/server/instagram-proxy-watch.ts).
 */

export interface ProxyCheck {
  ok: boolean;
  /** Причина словами; null — сторона в порядке. */
  outbound: string | null;
  inbound: string | null;
  checkedAt: string;
}

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Причины одной строкой, без повторов: когда прокси лежит целиком, обе
 * стороны называют одно и то же, и дважды подряд это читается как две беды.
 */
export function reasonOf(check: ProxyCheck): string {
  return [
    ...new Set(
      [check.outbound, check.inbound].filter((r): r is string => Boolean(r)),
    ),
  ].join(" ");
}

async function checkOutbound(fetchImpl?: FetchLike): Promise<string | null> {
  const out = await graphRequest({
    path: "me",
    timeoutMs: PROBE_TIMEOUT_MS,
    fetchImpl,
  });
  if (out.kind === "ok" || out.kind === "meta_error") return null;
  return describeProxyFailure(out) ?? "неизвестный сбой";
}

async function checkInbound(
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  const url = proxyWebhookUrl();
  if (!url)
    return "Не задан адрес прокси: INSTAGRAM_GRAPH_BASE не указывает на прокси.";
  let res: Response;
  try {
    res = await fetchImpl(`${url}?hub.mode=ping`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as Error)?.name;
    return name === "TimeoutError" || name === "AbortError"
      ? "Прокси Instagram не ответил вовремя."
      : "Прокси Instagram недоступен — нет связи с Vercel.";
  }
  const own = res.headers.get(PROXY_OWN_HEADER);
  const body = await res.text().catch(() => "");
  if (res.ok && body.trim() === PING_REPLY) return null;
  if (own === "origin unreachable") {
    return "Прокси работает, но не достучался до сервера клиники — события Meta не дойдут.";
  }
  if (own) return `Прокси Instagram ответил ошибкой: ${own}.`;
  if (res.status === 403) {
    return "Сервер клиники не принял секрет прокси: PROXY_SECRET на Vercel не совпадает с INSTAGRAM_PROXY_SECRET.";
  }
  return `Цепочка «прокси → сервер клиники» ответила ${res.status}.`;
}

export async function checkProxy(fetchImpl?: FetchLike): Promise<ProxyCheck> {
  const [outbound, inbound] = await Promise.all([
    checkOutbound(fetchImpl),
    checkInbound(fetchImpl),
  ]);
  return {
    ok: !outbound && !inbound,
    outbound,
    inbound,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Сколько проверок подряд должно не пройти, прежде чем будить людей.
 *
 * Одна неудача — это и перезапуск нашего же приложения, и секундный сбой
 * Vercel. Уведомление о каждом таком случае перестают читать, а вместе с ним —
 * и настоящее. Две подряд — это десять минут без связи: уже не мигание.
 */
export const FAILURES_BEFORE_ALERT = 2;

export interface WatchState {
  failures: number;
  /** Уведомление о сбое ушло и ещё не закрыто уведомлением о восстановлении. */
  alerted: boolean;
  last: ProxyCheck | null;
}

export const INITIAL_WATCH: WatchState = {
  failures: 0,
  alerted: false,
  last: null,
};

/**
 * Что делать после очередной проверки. Уведомляем о переходах, а не о
 * состояниях: «прокси лежит» — один раз, «прокси снова работает» — один раз.
 */
export function nextWatch(
  state: WatchState,
  check: ProxyCheck,
): { state: WatchState; alert: "down" | "recovered" | null } {
  if (check.ok) {
    return {
      state: { failures: 0, alerted: false, last: check },
      alert: state.alerted ? "recovered" : null,
    };
  }
  const failures = state.failures + 1;
  const alert =
    !state.alerted && failures >= FAILURES_BEFORE_ALERT ? "down" : null;
  return {
    state: {
      failures,
      alerted: state.alerted || alert === "down",
      last: check,
    },
    alert,
  };
}
