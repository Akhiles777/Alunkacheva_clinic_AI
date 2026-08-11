import {
  ENDPOINTS,
  RATE_LIMIT,
  YCLIENTS_ACCEPT,
  YCLIENTS_BASE_URL,
  isYclientsEnabled,
} from "./config";
import { authHeader, loadYclientsCredentials, type YclientsCredentials } from "./credentials";
import type { YclientsEnvelope } from "./types";

/**
 * Единый клиент YCLIENTS: последовательная очередь с ограничением частоты и
 * экспоненциальным ретраем на 429/5xx (§5). Прямые fetch из бизнес-логики
 * запрещены — всё идёт через него.
 *
 * Пока интеграция выключена (`YCLIENTS_ENABLED=false`) любой вызов бросает
 * YclientsDisabledError — сетевых запросов не делаем.
 */
export class YclientsDisabledError extends Error {
  constructor() {
    super("Интеграция YCLIENTS выключена или не настроена (YCLIENTS_ENABLED).");
    this.name = "YclientsDisabledError";
  }
}

export class YclientsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "YclientsApiError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Глобальная последовательная очередь — соблюдаем минимальный интервал. */
let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = RATE_LIMIT.minIntervalMs - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      lastAt = Date.now();
    }
  });
  // Очередь не должна рваться из-за ошибки одной задачи.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Ответ вместе с метаданными: total_count нужен постраничной выгрузке. */
export interface YclientsPage<T> {
  data: T;
  totalCount: number | null;
}

export interface YclientsClientHandle {
  creds: YclientsCredentials;
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  /** То же, но с meta: без total_count нельзя понять, есть ли ещё страницы. */
  getPage<T>(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<YclientsPage<T>>;
  /** Запись в YCLIENTS: создание, изменение и удаление визита (§2). */
  send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>;
  endpoints: typeof ENDPOINTS;
}

/**
 * Создаёт клиент для филиала. Возвращает null, если интеграция выключена или
 * креды не заданы — вызывающий код тогда просто ничего не синкает.
 */
export async function getYclientsClient(companyId: string): Promise<YclientsClientHandle | null> {
  if (!isYclientsEnabled()) return null;
  const loaded = await loadYclientsCredentials(companyId);
  if (!loaded) return null;
  const creds: YclientsCredentials = loaded;

  function buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(YCLIENTS_BASE_URL + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async function get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const page = await enqueue(() => request<T>(buildUrl(path, query), creds));
    return page.data;
  }

  async function getPage<T>(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<YclientsPage<T>> {
    return enqueue(() => request<T>(buildUrl(path, query), creds));
  }

  async function send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const page = await enqueue(() => request<T>(buildUrl(path), creds, { method, body }));
    return page.data;
  }

  return { creds, get, getPage, send, endpoints: ENDPOINTS };
}

async function request<T>(
  url: string,
  creds: YclientsCredentials,
  write?: { method: "POST" | "PUT" | "DELETE"; body?: unknown },
): Promise<YclientsPage<T>> {
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: write?.method ?? "GET",
        headers: {
          Accept: YCLIENTS_ACCEPT,
          Authorization: authHeader(creds),
          ...(write?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: write?.body !== undefined ? JSON.stringify(write.body) : undefined,
      });
    } catch (e) {
      // Сетевой сбой при записи: неизвестно, дошёл ли запрос. Повторять нельзя.
      if (write) throw new YclientsApiError(`Сеть недоступна: ${(e as Error).message}`, 0);
      if (attempt < RATE_LIMIT.maxRetries) {
        await sleep(RATE_LIMIT.baseDelayMs * 2 ** attempt);
        attempt += 1;
        continue;
      }
      throw new YclientsApiError(`Сеть недоступна: ${(e as Error).message}`, 0);
    }

    /**
     * Повторяем только безопасные случаи. Запись повторять на таймауте нельзя
     * вслепую: визит мог быть создан, и второй заход сделал бы дубль в чужом
     * расписании. Для записи повторяем лишь 429 — там сервер явно просит
     * подождать и заведомо ничего не выполнил.
     */
    const retryable = write ? res.status === 429 : res.status === 429 || res.status >= 500;
    if (retryable) {
      if (attempt < RATE_LIMIT.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : RATE_LIMIT.baseDelayMs * 2 ** attempt;
        await sleep(delay);
        attempt += 1;
        continue;
      }
    }

    if (!res.ok) {
      throw new YclientsApiError(`YCLIENTS ${res.status} на ${url}`, res.status);
    }

    const body = (await res.json()) as YclientsEnvelope<T> | T;
    // Ответы v2 приходят в конверте { success, data, meta }. total_count есть
    // не везде — постраничная выгрузка не должна на него полагаться.
    if (body && typeof body === "object" && "data" in (body as object)) {
      const envelope = body as YclientsEnvelope<T>;
      const total = envelope.meta?.total_count ?? envelope.meta?.count ?? null;
      return { data: envelope.data, totalCount: typeof total === "number" ? total : null };
    }
    return { data: body as T, totalCount: null };
  }
}
