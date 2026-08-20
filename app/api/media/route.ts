import { NextResponse } from "next/server";
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
 * Файл не сохраняется у нас: он живёт у провайдера, мы лишь передаём его в
 * ответ. Своего хранилища у платформы пока нет, и заводить его молча —
 * значит разнести медицинские данные ещё по одному месту.
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
      return NextResponse.json({ error: "файл недоступен" }, { status: 404 });
    }
    source = found.url;
    declaredType = found.mimeType;
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
): Promise<{ url: string; mimeType: string | null } | null> {
  const message = await prisma.message.findFirst({
    where: { id: messageId, conversation: { companyId } },
    select: { attachments: true },
  });
  if (!message) return null;
  const list = Array.isArray(message.attachments) ? message.attachments : [];
  const item = list[Number.isFinite(index) && index >= 0 ? index : 0];
  if (!item || typeof item !== "object") return null;
  const attachment = item as { source?: { url?: unknown }; mimeType?: unknown };
  const raw = attachment.source?.url;
  if (typeof raw !== "string") return null;
  try {
    if (new URL(raw).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    url: raw,
    mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : null,
  };
}
