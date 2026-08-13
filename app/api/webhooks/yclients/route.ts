import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isYclientsEnabled } from "@/lib/integrations/yclients/config";
import { parseWebhook, verifyWebhookSecret } from "@/lib/integrations/yclients/webhook";
import { handleWebhookEvent, type ProcessOutcome } from "@/lib/integrations/yclients/webhook-process";

/**
 * Приём вебхуков YCLIENTS. Пока интеграция выключена (YCLIENTS_ENABLED=false) —
 * отвечаем 503 и ничего не обрабатываем.
 *
 * Отвечаем 200 даже когда часть событий не удалось применить: YCLIENTS на
 * ошибку начнёт слать повторы, а событие у нас уже сохранено и видно в
 * webhook_events. Терять доставки из-за одной неудачной записи нельзя.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  if (events.length === 0) return NextResponse.json({ accepted: 0 });

  /**
   * Филиал определяем по company_id из события, сверяя его с сохранёнными
   * ключами. Брать «первую компанию» нельзя: в базе их может быть несколько, и
   * чужие записи уехали бы не туда.
   */
  const companyId = await resolveCompany(events[0]?.company_id);
  if (!companyId) {
    return NextResponse.json({ error: "unknown company" }, { status: 404 });
  }

  const outcomes: Record<ProcessOutcome, number> = {
    processed: 0,
    duplicate: 0,
    deferred: 0,
    ignored: 0,
    failed: 0,
  };
  for (const event of events) {
    const result = await handleWebhookEvent(companyId, event);
    outcomes[result] += 1;
  }

  return NextResponse.json({ accepted: events.length, ...outcomes });
}

/**
 * Наш companyId по идентификатору филиала YCLIENTS из события.
 *
 * Прежде при отсутствии company_id требовалась ровно одна клиника в базе. На
 * боевой базе их оказалось две — настоящая и пустой дубль, оставшийся от
 * ранней настройки, — и все такие события отлетали бы с «unknown company».
 * Синхронизация при этом выглядит настроенной: ключи заданы, проверка связи
 * зелёная, а расписание молчит.
 *
 * Поэтому лишняя пустая запись больше не ломает приём. Двусмысленность
 * остаётся ошибкой: если привязанных к YCLIENTS клиник несколько, угадывать
 * нельзя — записи уехали бы не туда.
 */
async function resolveCompany(external: number | string | undefined): Promise<string | null> {
  if (external !== undefined) {
    const yclientsId = Number(external);
    if (!Number.isFinite(yclientsId)) return null;
    const company = await prisma.company.findFirst({ where: { yclientsId }, select: { id: true } });
    return company?.id ?? null;
  }

  /**
   * Событие без company_id. Берём клинику, привязанную к настоящему филиалу:
   * временные номера из начальных данных лежат ниже ста, настоящие
   * идентификаторы YCLIENTS — заметно выше.
   */
  const bound = await prisma.company.findMany({
    where: { yclientsId: { gte: 100 } },
    select: { id: true },
    take: 2,
  });
  if (bound.length === 1) return bound[0].id;
  if (bound.length > 1) return null;

  // Ни одна клиника не привязана — тогда работает прежнее правило.
  const any = await prisma.company.findMany({ select: { id: true }, take: 2 });
  return any.length === 1 ? any[0].id : null;
}
