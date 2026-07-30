import { NextResponse } from "next/server";
import { isYclientsEnabled } from "@/lib/integrations/yclients/config";
import { parseWebhook, verifyWebhookSecret } from "@/lib/integrations/yclients/webhook";

/**
 * Приём вебхуков YCLIENTS. Пока интеграция выключена (YCLIENTS_ENABLED=false) —
 * отвечаем 503 и ничего не обрабатываем. Когда включим: проверяем секрет,
 * валидируем тело (zod), точечно догоняем проекцию по затронутой сущности.
 *
 * Идемпотентность обеспечивается upsert по yclients*Id в слое sync — повторная
 * доставка одного события безопасна.
 */
export async function POST(req: Request) {
  if (!isYclientsEnabled()) {
    return NextResponse.json({ error: "YCLIENTS integration disabled" }, { status: 503 });
  }

  const provided = req.headers.get("x-yclients-secret") ?? new URL(req.url).searchParams.get("secret");
  if (!verifyWebhookSecret(provided)) {
    return NextResponse.json({ error: "invalid secret" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const events = parseWebhook(body);
  // TODO(этап 1): по каждому событию точечно догнать проекцию (entityForResource
  // + адресный upsert по resource_id). Пока принимаем и подтверждаем приём.
  return NextResponse.json({ accepted: events.length });
}
