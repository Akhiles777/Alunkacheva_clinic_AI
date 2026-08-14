import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { chatIdFromPhone } from "./chat-id";
import {
  ENDPOINTS,
  GREEN_API_BASE,
  isWhatsappEnabled,
  RATE_LIMIT,
  STATE_HINT,
  WHATSAPP_PROVIDER,
} from "./config";

/**
 * Клиент Green API: единая очередь с ограничением частоты и осторожными
 * повторами. Прямые fetch из бизнес-логики запрещены (§5).
 *
 * Главное отличие от чтения: отправку нельзя повторять вслепую. Если запрос
 * оборвался на таймауте, сообщение могло уйти — и повтор пришлёт пациенту
 * второе. Поэтому повторяем только явные «подожди» и отказы до обработки.
 */

export interface WhatsappCredentials {
  idInstance: string;
  apiToken: string;
}

export interface SendResult {
  ok: boolean;
  /** Идентификатор сообщения у провайдера — для идемпотентности и статусов. */
  externalId?: string;
  /** Причина, понятная человеку: она попадёт на экран администратору. */
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function loadCredentials(companyId: string): Promise<WhatsappCredentials | null> {
  const rows = await prisma.credential.findMany({
    where: { companyId, provider: WHATSAPP_PROVIDER },
    select: { keyName: true, valueEncrypted: true },
  });
  const byKey = new Map(rows.map((r) => [r.keyName, r.valueEncrypted]));
  const id = byKey.get("id_instance");
  const token = byKey.get("api_token");
  if (!id || !token) return null;
  try {
    return { idInstance: decryptSecret(id), apiToken: decryptSecret(token) };
  } catch {
    // Сменившийся мастер-ключ или повреждённый шифртекст — считаем ненастроенным.
    return null;
  }
}

async function call<T>(
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
  const url = `${GREEN_API_BASE}${path}`;
  const isWrite = body !== undefined;
  let attempt = 0;

  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: isWrite ? "POST" : "GET",
        headers: isWrite ? { "Content-Type": "application/json" } : {},
        body: isWrite ? JSON.stringify(body) : undefined,
        // Провайдер иногда отвечает долго; без предела запрос повиснет и
        // займёт соединение до бесконечности.
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      const message = (e as Error).name === "TimeoutError" ? "провайдер не ответил вовремя" : "сеть недоступна";
      // Отправку на обрыве не повторяем: сообщение могло уйти, и повтор
      // пришлёт пациенту второе.
      if (isWrite || attempt >= RATE_LIMIT.maxRetries) return { ok: false, error: message, status: 0 };
      await sleep(RATE_LIMIT.baseDelayMs * 2 ** attempt);
      attempt += 1;
      continue;
    }

    // 429 — провайдер прямо просит подождать и заведомо ничего не выполнил.
    if (res.status === 429 && attempt < RATE_LIMIT.maxRetries) {
      await sleep(RATE_LIMIT.baseDelayMs * 2 ** attempt);
      attempt += 1;
      continue;
    }
    if (!isWrite && res.status >= 500 && attempt < RATE_LIMIT.maxRetries) {
      await sleep(RATE_LIMIT.baseDelayMs * 2 ** attempt);
      attempt += 1;
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: describeError(res.status, text) };
    }
    return { ok: true, data: (await res.json()) as T };
  }
}

/** Человеческое объяснение вместо кода ответа: его увидит администратор. */
function describeError(status: number, body: string): string {
  if (status === 401 || status === 403) return "неверные ключи Green API";
  if (status === 466) return "исчерпан лимит тарифа Green API";
  if (status === 400 && /not.*whatsapp|no.*account/i.test(body)) {
    return "у этого номера нет WhatsApp";
  }
  return `Green API ответил ${status}${body ? `: ${body.slice(0, 120)}` : ""}`;
}

/**
 * Состояние инстанса. Отправлять можно только из authorized — остальные
 * состояния сообщаем словами, чтобы «сообщение не ушло» не было загадкой.
 */
export async function instanceState(companyId: string): Promise<{ state: string; hint: string } | null> {
  if (!isWhatsappEnabled()) return null;
  const creds = await loadCredentials(companyId);
  if (!creds) return null;

  const res = await enqueue(() =>
    call<{ stateInstance?: string }>(ENDPOINTS.getStateInstance(creds.idInstance, creds.apiToken)),
  );
  if (!res.ok) return { state: "unknown", hint: res.error };
  const state = res.data.stateInstance ?? "unknown";
  return { state, hint: STATE_HINT[state] ?? state };
}

/**
 * Отправить текст пациенту.
 *
 * Адресуем по телефону, а не по chatId из переписки: телефон — наш ключ
 * пациента (§4), и он же остаётся верным, если провайдер сменится.
 */
export async function sendText(
  companyId: string,
  phoneOrChatId: string,
  text: string,
): Promise<SendResult> {
  if (!isWhatsappEnabled()) return { ok: false, error: "Интеграция WhatsApp выключена" };

  const creds = await loadCredentials(companyId);
  if (!creds) return { ok: false, error: "Не заданы ключи Green API" };

  // На вход принимаем и телефон, и готовый chatId: диалог хранит chatId, а
  // напоминания отправляются по номеру из карточки.
  const chatId = phoneOrChatId.includes("@") ? phoneOrChatId : chatIdFromPhone(phoneOrChatId);
  if (!chatId) return { ok: false, error: "Не удалось разобрать номер получателя" };

  const body = text.trim();
  if (!body) return { ok: false, error: "Пустое сообщение" };

  const res = await enqueue(() =>
    call<{ idMessage?: string }>(ENDPOINTS.sendMessage(creds.idInstance, creds.apiToken), {
      chatId,
      // Green API ограничивает длину; режем заранее, чтобы не получить отказ
      // на всём сообщении.
      message: body.slice(0, 4000),
    }),
  );

  if (!res.ok) return { ok: false, error: res.error };
  if (!res.data.idMessage) {
    // Ответ без идентификатора: сообщение могло уйти. Не подтверждаем
    // доставку, но и не отправляем второе — решает человек.
    return { ok: false, error: "Green API не вернул идентификатор сообщения" };
  }
  return { ok: true, externalId: res.data.idMessage };
}

/** Одно сообщение из истории переписки. */
export interface HistoryMessage {
  externalId: string;
  /** Кто написал: пациент или клиника. */
  direction: "IN" | "OUT";
  text: string;
  at: Date;
}

/**
 * История переписки с собеседником.
 *
 * До подключения платформы клиника переписывалась с пациентом прямо на
 * телефоне. Эти сообщения есть у WhatsApp, но не у нас — и ассистент начинал
 * разговор с чистого листа при живой переписке на экране у пациента. Забираем
 * их один раз, при первом сообщении в новом диалоге.
 *
 * Ошибки здесь не критичны: не получилось — работаем без истории, как раньше.
 * Терять входящее сообщение из-за неудачной подгрузки нельзя.
 */
export async function fetchChatHistory(
  companyId: string,
  chatId: string,
  count = 50,
): Promise<HistoryMessage[]> {
  if (!isWhatsappEnabled()) return [];
  const creds = await loadCredentials(companyId);
  if (!creds) return [];

  const res = await enqueue(() =>
    call<unknown>(ENDPOINTS.getChatHistory(creds.idInstance, creds.apiToken), { chatId, count }),
  );
  if (!res.ok || !Array.isArray(res.data)) return [];

  return parseHistory(res.data);
}

/**
 * Разбор ответа истории. Отдельно от запроса — чтобы проверять тестами без
 * сети: формат у провайдера разный для текста, подписи к файлу и цитаты.
 */
export function parseHistory(rows: unknown[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const raw of rows) {
    // Провайдер присылает и пустые элементы: обращение к полю null уронило бы
    // разбор целиком, а вместе с ним и всю подгруженную историю.
    if (!raw || typeof raw !== "object") continue;
    const m = raw as {
      idMessage?: string;
      type?: string;
      timestamp?: number;
      textMessage?: string;
      extendedTextMessage?: { text?: string };
      extendedTextMessageData?: { text?: string };
      caption?: string;
      typeMessage?: string;
    };
    if (!m.idMessage || !m.timestamp) continue;

    const text = (
      m.textMessage ??
      m.extendedTextMessage?.text ??
      m.extendedTextMessageData?.text ??
      m.caption ??
      ""
    ).trim();
    // Нетекстовые сообщения истории помечаем: содержимое нам недоступно, но
    // сам факт обмена важен для понимания разговора.
    const body = text || (m.typeMessage ? `[${m.typeMessage}]` : "");
    if (!body) continue;

    out.push({
      externalId: m.idMessage,
      direction: m.type === "outgoing" ? "OUT" : "IN",
      text: body.slice(0, 4000),
      at: new Date(m.timestamp * 1000),
    });
  }
  // От старых к новым: в таком порядке они лягут в переписку.
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
