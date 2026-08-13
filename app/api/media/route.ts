import { NextResponse } from "next/server";
import { getSessionOrNull } from "@/lib/server/session";
import { fileLink } from "@/lib/integrations/telegram/client";

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

  if (provider === "TELEGRAM") {
    source = await fileLink(ref);
    if (!source) return NextResponse.json({ error: "файл недоступен" }, { status: 404 });
  } else if (provider === "WHATSAPP") {
    /**
     * Адрес приходит из вебхука провайдера, но доверять ему на слово нельзя:
     * подставив сюда чужой адрес, можно заставить наш сервер сходить во
     * внутреннюю сеть и вернуть ответ наружу. Пускаем только к провайдеру.
     */
    if (!isGreenApiUrl(ref)) {
      return NextResponse.json({ error: "недопустимый адрес файла" }, { status: 400 });
    }
    source = ref;
  } else {
    return NextResponse.json({ error: "неизвестный источник" }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(source, { signal: AbortSignal.timeout(20_000) });
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

  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      // Кэш только у сотрудника в браузере и ненадолго: файл содержит
      // персональные данные, общим кэшам его отдавать нельзя.
      "Cache-Control": "private, max-age=300",
      "Content-Disposition": "inline",
    },
  });
}

function isGreenApiUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /(^|\.)green-api\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}
