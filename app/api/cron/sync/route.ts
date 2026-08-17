import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { syncAll } from "@/lib/integrations/yclients/sync";
import { recomputeVisitKinds, backfillRooms, backfillFirstSeen } from "@/lib/metrics/recompute";

/**
 * Синхронизация с YCLIENTS по расписанию.
 *
 * До сих пор выгрузка запускалась только кнопкой в настройках. Значит статусы
 * визитов обновлялись ровно тогда, когда кто-то вспоминал нажать кнопку, — а
 * администратор отмечает «пришёл» каждый день. В отчётах это выглядело как
 * «приёмов шестнадцать, пришёл один»: приёмы приехали с выгрузкой, отметки о
 * посещении — нет.
 *
 * Своего планировщика у приложения нет (§3 предполагал воркеры на BullMQ, но
 * на сервере их не разворачивали), поэтому вызывать этот адрес должен
 * системный cron. Строка для crontab — в .env.example рядом с секретом.
 *
 * Адрес закрыт секретом: без него любой желающий мог бы запускать выгрузку и
 * упереть клинику в лимит запросов YCLIENTS.
 */

export const runtime = "nodejs";
/** Полная выгрузка длинная: месячные окна за несколько лет. */
export const maxDuration = 800;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function run(): Promise<Response> {
  const companies = await prisma.company.findMany({
    // Клиники, привязанные к филиалу YCLIENTS. Временные номера из начальных
    // данных лежат ниже ста — их синхронизировать не с чем.
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  if (companies.length === 0) {
    return NextResponse.json({ ok: true, skipped: "нет клиник, привязанных к YCLIENTS" });
  }

  const results: Record<string, unknown>[] = [];
  for (const company of companies) {
    const started = Date.now();
    try {
      const counts = await syncAll(company.id);

      /**
       * После выгрузки — пересчёт производных полей. Первичность визита
       * зависит от всей истории пациента, и без пересчёта отчёты показывают
       * прежние значения при новых данных.
       */
      const [kinds, rooms, firstSeen] = await Promise.all([
        recomputeVisitKinds(company.id),
        backfillRooms(company.id),
        backfillFirstSeen(company.id),
      ]);

      results.push({
        company: company.name,
        counts,
        recomputed: kinds.updated,
        roomsFilled: rooms,
        firstSeenFixed: firstSeen,
        ms: Date.now() - started,
      });
    } catch (e) {
      // Одна клиника не должна ронять выгрузку остальных.
      console.error(`[cron] выгрузка ${company.name} не удалась:`, e);
      results.push({ company: company.name, error: String((e as Error)?.message ?? e) });
    }
  }

  return NextResponse.json({ ok: true, at: new Date().toISOString(), results });
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "нужен CRON_SECRET" }, { status: 401 });
  }
  return run();
}

/** GET — чтобы запускать той же строкой curl из crontab. */
export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "нужен CRON_SECRET" }, { status: 401 });
  }
  return run();
}
