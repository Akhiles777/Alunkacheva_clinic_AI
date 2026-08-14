import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { GRAPH_BASE_URL, INSTAGRAM_PROVIDER, RATE_LIMIT, isInstagramEnabled, windowOpen } from "./config";

/**
 * Отправка в Instagram Direct. Единственное место, откуда уходят запросы к
 * Meta: бизнес-логика про HTTP ничего не знает (§5).
 *
 * Как и в WhatsApp, отправку не повторяем вслепую: если запрос оборвался на
 * таймауте, сообщение могло уйти, и повтор пришлёт пациенту второе.
 */

export interface SendResult {
  ok: boolean;
  externalId?: string;
  /** Причина словами: её увидит администратор. */
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

async function pageToken(companyId: string): Promise<string | null> {
  const row = await prisma.credential.findFirst({
    where: { companyId, provider: INSTAGRAM_PROVIDER, keyName: "page_token" },
    select: { valueEncrypted: true },
  });
  if (!row) return null;
  try {
    return decryptSecret(row.valueEncrypted);
  } catch {
    // Сменившийся мастер-ключ или повреждённый шифртекст — считаем ненастроенным.
    return null;
  }
}

/** Понятное объяснение вместо кода ответа. */
function describeError(status: number, body: string): string {
  if (/outside.*24|message.*window|#10\b/i.test(body)) {
    return "Прошло больше суток с последнего сообщения пациента — Instagram не разрешает отвечать. Напишите ему из приложения.";
  }
  if (status === 401 || status === 403) return "Instagram не принял токен страницы: проверьте его в разделе «Интеграции».";
  if (status === 429) return "Instagram временно ограничил отправку — попробуйте позже.";
  return `Instagram ответил ${status}${body ? `: ${body.slice(0, 120)}` : ""}`;
}

/**
 * Отправить текст пациенту.
 *
 * Окно ответа проверяется до запроса, а не по факту отказа: администратору
 * нужно понимать, почему сообщение не ушло, а не видеть загадочный код Meta.
 */
export async function sendText(
  companyId: string,
  recipientId: string,
  text: string,
  lastPatientMessageAt: Date | null,
): Promise<SendResult> {
  if (!isInstagramEnabled()) return { ok: false, error: "Интеграция Instagram выключена" };

  if (!windowOpen(lastPatientMessageAt)) {
    return {
      ok: false,
      error: "Окно ответа закрыто: Instagram разрешает писать в течение суток с сообщения пациента.",
    };
  }

  const token = await pageToken(companyId);
  if (!token) return { ok: false, error: "Не задан токен страницы Instagram" };

  const body = text.trim();
  if (!body) return { ok: false, error: "Пустое сообщение" };

  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${GRAPH_BASE_URL}/me/messages?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: body.slice(0, 1000) },
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      // Обрыв на отправке не повторяем: сообщение могло уйти.
      return {
        ok: false,
        error: (e as Error).name === "TimeoutError" ? "Instagram не ответил вовремя" : "нет связи с Instagram",
      };
    }

    // 429 — Meta прямо просит подождать и заведомо ничего не выполнила.
    if (res.status === 429 && attempt < RATE_LIMIT.maxRetries) {
      await sleep(RATE_LIMIT.baseDelayMs * 2 ** attempt);
      attempt += 1;
      continue;
    }

    const raw = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, error: describeError(res.status, raw) };

    try {
      const json = JSON.parse(raw) as { message_id?: string };
      return { ok: true, externalId: json.message_id };
    } catch {
      // Ответ без разбираемого тела: сообщение, скорее всего, ушло. Второго не
      // шлём — решает человек.
      return { ok: true };
    }
  }
}

/** Обёртка с очередью: наружу вызывается только она. */
export function sendInstagram(
  companyId: string,
  recipientId: string,
  text: string,
  lastPatientMessageAt: Date | null,
): Promise<SendResult> {
  return enqueue(() => sendText(companyId, recipientId, text, lastPatientMessageAt));
}
