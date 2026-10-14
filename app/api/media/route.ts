import { NextResponse, after } from "next/server";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { freshFileUrl } from "@/lib/integrations/whatsapp/green-api";
import { cacheMessageAttachments, fetchRemote } from "@/lib/media/remote-cache";
import { locate, pathOf } from "@/lib/media/store";
import { getSessionOrNull } from "@/lib/server/session";
import { fileLink } from "@/lib/integrations/telegram/client";
import { prisma } from "@/lib/db";

/**
 * Отдача вложений пациента сотруднику.
 *
 * Почему через свой адрес, а не ссылкой напрямую:
 *
 *   1. Ссылка Telegram содержит токен бота. Положи её в базу или в разметку —
 *      и любой, кто её увидел, получит полный доступ к переписке клиники со
 *      всеми пациентами. Здесь токен остаётся на сервере.
 *   2. Ссылка провайдера открыта любому, кто её знает. Голосовое пациента —
 *      это сведения о факте обращения за помощью, то есть врачебная тайна
 *      (§7, ст. 13 323-ФЗ). Отдаём только вошедшему сотруднику.
 *
 * Файлы WhatsApp сохраняются у нас при получении (`lib/media/remote-cache`):
 * ссылка провайдера живёт ограниченное время, и вложения переставали
 * открываться. Старые, пришедшие до этого, берутся по ссылке, а если она
 * истекла — по свежей (`downloadFile`), и тут же сохраняются к себе.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Больше этого не пропускаем: канал сотрудника не должен вставать колом. */
const MAX_BYTES = 25 * 1024 * 1024;

export async function GET(req: Request) {
  const session = await getSessionOrNull();
  if (!session) return NextResponse.json({ error: "нужен вход" }, { status: 401 });

  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");
  const ref = url.searchParams.get("ref");
  if (!ref) return NextResponse.json({ error: "не указан файл" }, { status: 400 });

  let source: string | null = null;
  /**
   * Тип файла из вебхука провайдера.
   *
   * Хранилище отдаёт файлы с `application/octet-stream` — для него это просто
   * байты. Браузер с таким типом проигрыватель не заводит: тег audio молчит,
   * и голосовое выглядит сломанным. Провайдер тип знает и присылает его в
   * вебхуке («audio/ogg; codecs=opus») — он и точнее.
   */
  let declaredType: string | null = null;

  /**
   * Наш собственный файл — тот, который клиника отправила пациенту.
   *
   * Он лежит на диске, а не у провайдера, поэтому и отдаётся иначе: без
   * похода наружу. Проверка та же и по той же причине — файл принадлежит
   * клинике сотрудника, иначе по чужому идентификатору открылась бы
   * переписка соседней клиники (§7).
   */
  if (provider === "LOCAL") {
    const row = await prisma.mediaFile.findFirst({
      where: { id: ref, companyId: session.companyId, deletedAt: null },
      select: { storageId: true, mimeType: true, fileName: true },
    });
    if (!row) {
      console.warn(`[media] LOCAL ${ref}: карточки файла нет`);
      return NextResponse.json({ error: "файл недоступен" }, { status: 404 });
    }
    return localFile(row.storageId, row.mimeType, req.headers.get("range"));
  }

  if (provider === "TELEGRAM") {
    source = await fileLink(ref);
    if (!source) return NextResponse.json({ error: "файл недоступен" }, { status: 404 });
  } else if (provider === "WHATSAPP") {
    /**
     * Адрес берём из своей базы по номеру сообщения, а не из запроса.
     *
     * Раньше сюда приходил сам адрес, и пускали его по списку хостов —
     * `green-api.com`. Провайдер отдаёт файлы со своего хранилища, домен там
     * другой, и наша же проверка резала ссылку: администратор видел
     * проигрыватель, который молча не играл. Голосовые пациентов не
     * прослушивались вовсе.
     *
     * Список хостов был обходным путём вокруг настоящей опасности: подставив
     * чужой адрес, можно заставить сервер сходить во внутреннюю сеть. Теперь
     * подставлять нечего — адрес приходит из вложения, которое мы сами
     * записали, а сообщение обязано принадлежать той же клинике, что и
     * сотрудник. Это и безопаснее списка, и работает с любым хранилищем.
     */
    const found = await whatsappFile(ref, session.companyId, Number(url.searchParams.get("i") ?? 0));
    if (!found) {
      console.warn(`[media] WHATSAPP msg=${ref}: вложение не найдено в сообщении`);
      return NextResponse.json({ error: "файл недоступен" }, { status: 404 });
    }
    // Уже сохранён у нас — отдаём с диска.
    if (found.local) return localFile(found.local.storageId, found.local.mimeType, req.headers.get("range"));
    source = found.url;
    declaredType = found.mimeType;
    const range = req.headers.get("range");
    const init = range ? { headers: { Range: range } } : {};
    let got = await fetchRemote(source, init);
    // Ссылка истекла — просим у провайдера свежую по номеру сообщения.
    if (!got.ok && got.reason === "expired" && found.externalId) {
      const fresh = await freshFileUrl(session.companyId, found.chatId, found.externalId);
      if (fresh) got = await fetchRemote(fresh, init);
    }
    if (!got.ok) {
      // Только номер сообщения и причина — без ссылки и данных пациента (§7).
      console.warn(`[media] WHATSAPP msg=${ref}: провайдер не отдал файл (${got.reason})`);
      return NextResponse.json(
        {
          error:
            got.reason === "expired"
              ? "Файл больше не хранится у WhatsApp — попросите пациента прислать его ещё раз"
              : got.reason === "too_big"
                ? "Файл слишком большой для просмотра в переписке"
                : "WhatsApp сейчас не отдаёт файл — попробуйте позже",
        },
        { status: got.reason === "expired" ? 410 : 502 },
      );
    }
    // Пока открыли — сохраняем к себе, чтобы следующее открытие не зависело от провайдера.
    after(() => cacheMessageAttachments(ref).catch(() => 0));
    return proxied(got.response, declaredType);
  } else {
    return NextResponse.json({ error: "неизвестный источник" }, { status: 400 });
  }

  /**
   * Запрос по частям передаём дальше как есть.
   *
   * Браузер тянет звук кусками: сначала спрашивает первые байты, потом
   * перематывает. Без поддержки диапазонов проигрыватель у части браузеров
   * вовсе отказывается играть, а перемотка не работает нигде.
   */
  const range = req.headers.get("range");
  let upstream: Response;
  try {
    upstream = await fetch(source, {
      headers: range ? { Range: range } : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return NextResponse.json({ error: "источник не ответил" }, { status: 504 });
  }
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: "файл недоступен" }, { status: 404 });
  }

  const size = Number(upstream.headers.get("content-length") ?? 0);
  if (size > MAX_BYTES) {
    return NextResponse.json({ error: "файл слишком большой" }, { status: 413 });
  }

  const headers = new Headers({
    "Content-Type": playableType(upstream.headers.get("content-type"), declaredType),
    // Кэш только у сотрудника в браузере и ненадолго: файл содержит
    // персональные данные, общим кэшам его отдавать нельзя.
    "Cache-Control": "private, max-age=300",
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
  });
  for (const key of ["content-length", "content-range"]) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }

  return new NextResponse(upstream.body, { status: upstream.status, headers });
}

/**
 * Тип, с которым браузер согласится играть.
 *
 * Хранилище провайдера отдаёт голосовое как `application/octet-stream` — для
 * него это байты. Браузер с таким типом проигрыватель не заводит: тег audio
 * молчит, и голосовое выглядит сломанным, хотя файл целый. Тип из вебхука
 * точнее, потому что его назвал сам провайдер.
 */
function playableType(fromUpstream: string | null, declared: string | null): string {
  const generic = /^(application|binary)\/octet-stream$/i;
  const upstreamType = fromUpstream?.split(";")[0]?.trim() ?? "";
  if (declared && (!upstreamType || generic.test(upstreamType))) return declared;
  return fromUpstream ?? declared ?? "application/octet-stream";
}

/**
 * Адрес файла из сохранённого вложения.
 *
 * Сообщение должно принадлежать клинике сотрудника — иначе по чужому номеру
 * можно было бы вытянуть переписку соседней клиники. Возвращаем только
 * `https`: подставить туда внутренний адрес неоткуда, но и полагаться на это
 * не будем.
 */
async function whatsappFile(
  messageId: string,
  companyId: string,
  index: number,
): Promise<{
  url: string;
  mimeType: string | null;
  chatId: string;
  externalId: string | null;
  local: { storageId: string; mimeType: string } | null;
} | null> {
  const message = await prisma.message.findFirst({
    where: { id: messageId, conversation: { companyId } },
    select: { attachments: true, externalId: true, conversation: { select: { externalUserId: true } } },
  });
  if (!message) return null;
  const list = Array.isArray(message.attachments) ? message.attachments : [];
  const item = list[Number.isFinite(index) && index >= 0 ? index : 0];
  if (!item || typeof item !== "object") return null;
  const attachment = item as { source?: { url?: unknown; provider?: unknown; mediaId?: unknown }; mimeType?: unknown };
  // Сохранён у нас, пока экран показывал старую ссылку, — отдаём свой файл.
  let local: { storageId: string; mimeType: string } | null = null;
  if (attachment.source?.provider === "LOCAL" && typeof attachment.source.mediaId === "string") {
    local = await prisma.mediaFile.findFirst({
      where: { id: attachment.source.mediaId, companyId, deletedAt: null },
      select: { storageId: true, mimeType: true },
    });
  }
  const raw = attachment.source?.url;
  if (typeof raw !== "string") return local ? { url: "", mimeType: null, chatId: "", externalId: null, local } : null;
  try {
    if (new URL(raw).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    url: raw,
    mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : null,
    chatId: message.conversation.externalUserId,
    externalId: message.externalId,
    local,
  };
}

/** Ответ провайдера — дальше как есть, с типом, который браузер согласится играть. */
function proxied(upstream: Response, declaredType: string | null): NextResponse {
  const headers = new Headers({
    "Content-Type": playableType(upstream.headers.get("content-type"), declaredType),
    "Cache-Control": "private, max-age=300",
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
  });
  for (const key of ["content-length", "content-range"]) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}

/**
 * Свой файл с диска — потоком и с поддержкой частей.
 *
 * Прежде файл читался в память целиком и отдавался с `Accept-Ranges: none`.
 * Safari (iPhone и Mac) видео без частичных ответов не воспроизводит вовсе, а
 * перемотку голосового не умеет никто. Теперь — 206 на запрос диапазона.
 */
async function localFile(storageId: string, mimeType: string | null, range: string | null): Promise<NextResponse> {
  const at = await locate(storageId);
  const size = at?.size ?? null;
  if (!at || size === null) {
    console.warn(`[media] файл ${storageId} не найден на диске (${pathOf(storageId)})`);
    return NextResponse.json({ error: "файл недоступен" }, { status: 404 });
  }
  const type = mimeType || "application/octet-stream";
  const base = {
    "Content-Type": type,
    "Cache-Control": "private, max-age=300",
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
  };
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    start = Math.max(0, start);
    const stream = Readable.toWeb(createReadStream(at.path, { start, end })) as ReadableStream;
    return new NextResponse(stream, {
      status: 206,
      headers: { ...base, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
    });
  }
  const stream = Readable.toWeb(createReadStream(at.path)) as ReadableStream;
  return new NextResponse(stream, { headers: { ...base, "Content-Length": String(size) } });
}
