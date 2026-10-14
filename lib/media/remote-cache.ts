import { prisma } from "@/lib/db";
import { saveStream } from "@/lib/media/store";
import { freshFileUrl } from "@/lib/integrations/whatsapp/green-api";

/**
 * Файлы пациента — у нас, а не по ссылке провайдера.
 *
 * Вебхук Green API присылает ссылку на файл, и мы хранили только её, считая
 * «долгоживущей». Она живёт ограниченное время (срок хранения файлов, по
 * словам Green API, задаёт WhatsApp), и через какое-то время фото, видео и
 * голосовые в переписке перестают открываться: `/api/media` получает 404.
 * Поэтому файл сохраняется к себе сразу при получении, тем же хранилищем,
 * что и файлы, отправленные клиникой, и отдаётся с диска.
 *
 * Для вложений, пришедших до этой правки, есть запасной путь: старая ссылка,
 * затем свежая по номеру сообщения (`downloadFile`), и тогда файл тоже
 * сохраняется у нас. Не отдаёт и провайдер — так и говорим словами.
 */

/** Больше этого к себе не тянем: отдаём ссылкой провайдера, как раньше. */
export const CACHE_LIMIT_BYTES = 64 * 1024 * 1024;

export interface RemoteSource {
  provider: "WHATSAPP";
  url: string;
}

export type FetchOutcome =
  | { ok: true; response: Response }
  | { ok: false; reason: "expired" | "too_big" | "unreachable" };

/** Сходить за файлом. 4xx — ссылка больше не действует. */
export async function fetchRemote(url: string, init: RequestInit = {}): Promise<FetchOutcome> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if (r.status >= 400 && r.status < 500) return { ok: false, reason: "expired" };
    if (!r.ok || !r.body) return { ok: false, reason: "unreachable" };
    const size = Number(r.headers.get("content-length") ?? 0);
    if (size > CACHE_LIMIT_BYTES) {
      await r.body.cancel().catch(() => {});
      return { ok: false, reason: "too_big" };
    }
    return { ok: true, response: r };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

async function* bodyChunks(r: Response): AsyncIterable<Uint8Array> {
  const reader = r.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) yield value;
  }
}

interface StoredAttachment {
  kind?: string;
  mimeType?: string;
  fileName?: string;
  durationSec?: number;
  source?: { provider?: string; url?: string; mediaId?: string; origin?: string };
  [key: string]: unknown;
}

/** Идут ли уже по этому сообщению: вебхук и открытие экрана могут совпасть. */
const inFlight = new Map<string, Promise<number>>();

/**
 * Сохранить у себя все файлы сообщения, пришедшие ссылкой WhatsApp.
 * Возвращает, сколько сохранено. Повторный вызов ничего не делает: сохранённое
 * вложение уже ссылается на наш файл.
 */
export function cacheMessageAttachments(messageId: string): Promise<number> {
  const running = inFlight.get(messageId);
  if (running) return running;
  const job = cacheNow(messageId).finally(() => inFlight.delete(messageId));
  inFlight.set(messageId, job);
  return job;
}

async function cacheNow(messageId: string): Promise<number> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      companyId: true,
      externalId: true,
      attachments: true,
      conversation: { select: { externalUserId: true } },
    },
  });
  if (!message || !Array.isArray(message.attachments)) return 0;
  const list = message.attachments as StoredAttachment[];
  let saved = 0;
  const next = [...list];
  for (const [i, a] of list.entries()) {
    if (a?.source?.provider !== "WHATSAPP" || typeof a.source.url !== "string") continue;
    let got = await fetchRemote(a.source.url);
    if (!got.ok && got.reason === "expired" && message.externalId) {
      const fresh = await freshFileUrl(message.companyId, message.conversation.externalUserId, message.externalId);
      if (fresh) got = await fetchRemote(fresh);
    }
    if (!got.ok) continue;
    try {
      const stored = await saveStream(bodyChunks(got.response), CACHE_LIMIT_BYTES);
      const mimeType =
        a.mimeType || got.response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
      const row = await prisma.mediaFile.create({
        data: {
          companyId: message.companyId,
          storageId: stored.id,
          kind: a.kind ?? "other",
          mimeType,
          fileName: a.fileName ?? null,
          sizeBytes: stored.sizeBytes,
          durationSec: typeof a.durationSec === "number" ? a.durationSec : null,
          messageId: message.id,
        },
        select: { id: true },
      });
      // Ссылку провайдера оставляем рядом: по ней видно, откуда файл пришёл.
      next[i] = { ...a, source: { provider: "LOCAL", mediaId: row.id, origin: "WHATSAPP", url: a.source.url } };
      saved += 1;
    } catch (e) {
      console.error(`[вложение] не сохранилось у нас: ${(e as Error).message}`);
    }
  }
  if (saved > 0) {
    await prisma.message.update({ where: { id: message.id }, data: { attachments: next as unknown as object[] } });
  }
  return saved;
}
