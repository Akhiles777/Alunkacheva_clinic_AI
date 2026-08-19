/**
 * Сходятся ли отчёты с тем, что реально лежит в YCLIENTS.
 *
 * Проверять экраны глазами больше нельзя: услуга показывает ноль, и по виду
 * не отличить «её действительно не делали» от «мы потеряли её при разборе».
 * Скрипт читает сырые записи YCLIENTS и сравнивает три вещи:
 *
 *   1. Какие услуги названы в записях и сколько раз — по данным провайдера.
 *   2. Что из этого доехало к нам: основная услуга визита и полный состав.
 *   3. Сходятся ли итоги разрезов между собой — часы, визиты, выручка.
 *
 * Ничего не меняет. Имён и телефонов не печатает (§7).
 *
 *   npx tsx scripts/report-check.ts            — за 30 дней
 *   npx tsx scripts/report-check.ts --days=90
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { getYclientsClient } from "../lib/integrations/yclients/client";
import { apiDate, hasNextPage, monthWindows, PAGE_SIZE } from "../lib/integrations/yclients/paging";
import type { YclientsRecord } from "../lib/integrations/yclients/types";

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = Number(daysArg?.slice(7) ?? 30);
const hrs = (min: number) => `${Math.floor(min / 60)} ч ${min % 60} мин`;

async function main() {
  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  const now = new Date();
  const from = new Date(now.getTime() - DAYS * 24 * 3600 * 1000);
  console.log(`клиника: ${company.name}`);
  console.log(`период: ${apiDate(from)} — ${apiDate(now)}\n`);

  const client = await getYclientsClient(company.id);
  if (!client) {
    console.log("YCLIENTS выключен — сверять не с чем.");
    await prisma.$disconnect();
    return;
  }

  // ── 1. Что говорит YCLIENTS
  /** Название услуги → сколько раз названа, из них первой. */
  const remote = new Map<string, { total: number; first: number; ids: Set<number> }>();
  /** Номера записей YCLIENTS за период — по ним ищем, чего у нас нет. */
  const remoteIds = new Set<number>();
  let records = 0;
  let multiService = 0;

  for (const w of monthWindows(from, now)) {
    let page = 1;
    let fetched = 0;
    for (;;) {
      const res = await client.getPage<YclientsRecord[]>(
        client.endpoints.records(client.creds.companyId),
        { start_date: apiDate(w.from), end_date: apiDate(w.to), page, count: PAGE_SIZE },
      );
      const dtos = res.data ?? [];
      for (const d of dtos) {
        if (d.deleted) continue;
        const at = new Date(d.datetime);
        if (at < from || at > now) continue;
        records += 1;
        remoteIds.add(d.id);
        const svc = d.services ?? [];
        if (svc.length > 1) multiService += 1;
        svc.forEach((s, i) => {
          const key = s.title?.trim() || `услуга ${s.id}`;
          const acc = remote.get(key) ?? { total: 0, first: 0, ids: new Set<number>() };
          acc.total += 1;
          if (i === 0) acc.first += 1;
          acc.ids.add(s.id);
          remote.set(key, acc);
        });
      }
      fetched += dtos.length;
      if (!hasNextPage({ received: dtos.length, pageSize: PAGE_SIZE, fetchedSoFar: fetched, totalCount: res.totalCount, page })) break;
      page += 1;
    }
  }

  console.log(`── записей в YCLIENTS за период: ${records} ──`);
  console.log(`   из них с несколькими услугами: ${multiService}\n`);

  // ── 2. Что доехало к нам
  const ours = await prisma.appointment.findMany({
    where: { companyId: company.id, deletedAt: null, status: { not: "CANCELLED" }, startAt: { gte: from, lt: now } },
    select: {
      durationMin: true,
      revenue: true,
      status: true,
      primaryService: { select: { title: true } },
      services: { select: { durationMin: true, priceCharged: true, service: { select: { title: true } } } },
    },
  });

  /**
   * Записи YCLIENTS, которых у нас нет вовсе, и те, что у нас отменены.
   *
   * Без этого разрыв «285 записей там, 266 визитов здесь» выглядит одинаково
   * и когда визиты отменены (это нормально), и когда они не доехали (это
   * потеря).
   */
  const known = await prisma.appointment.findMany({
    where: { companyId: company.id, yclientsRecordId: { in: [...remoteIds] } },
    select: { yclientsRecordId: true, status: true, deletedAt: true },
  });
  const knownIds = new Set(known.map((a) => a.yclientsRecordId as number));
  const cancelledHere = known.filter((a) => a.status === "CANCELLED" || a.deletedAt !== null).length;
  const missing = [...remoteIds].filter((id) => !knownIds.has(id));

  const byPrimary = new Map<string, number>();
  const byComposition = new Map<string, { count: number; minutes: number }>();
  let visitMinutes = 0;
  let compositionMinutes = 0;
  /** Часы визитов, у которых состав записан: только их и сравниваем. */
  let composedVisitMinutes = 0;
  let withComposition = 0;
  let withoutService = 0;

  for (const a of ours) {
    visitMinutes += a.durationMin;
    const p = a.primaryService?.title;
    if (p) byPrimary.set(p, (byPrimary.get(p) ?? 0) + 1);
    else if (a.services.length === 0) withoutService += 1;

    if (a.services.length > 0) {
      withComposition += 1;
      composedVisitMinutes += a.durationMin;
    }
    for (const s of a.services) {
      const key = s.service.title;
      const acc = byComposition.get(key) ?? { count: 0, minutes: 0 };
      acc.count += 1;
      acc.minutes += s.durationMin;
      byComposition.set(key, acc);
      compositionMinutes += s.durationMin;
    }
  }

  console.log("── услуги: YCLIENTS против нашей базы ──");
  console.log("   названа = сколько раз услуга указана в записях");
  console.log("   первой  = сколько раз она была ПЕРВОЙ (только их видел старый отчёт)\n");
  const rows = [...remote.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [title, r] of rows) {
    const primary = byPrimary.get(title) ?? 0;
    const comp = byComposition.get(title)?.count ?? 0;
    const lost = r.total - Math.max(primary, comp);
    console.log(
      `  ${title}\n` +
        `      названа ${r.total} (первой ${r.first}) · у нас основной ${primary}, в составе ${comp}` +
        `${lost > 0 ? `  ← ТЕРЯЕМ ${lost}` : ""}`,
    );
  }

  // ── 3. Сходятся ли итоги
  console.log("\n── сходятся ли итоги ──");
  console.log(`  записей в YCLIENTS: ${records}`);
  console.log(`  из них у нас есть: ${knownIds.size}` +
    `${cancelledHere > 0 ? ` (отменённых или удалённых у нас: ${cancelledHere})` : ""}`);
  console.log(`  визитов в разрезе (не отменённых): ${ours.length}`);
  if (missing.length > 0) {
    console.log(
      `  ✗ НЕ ДОЕХАЛО: ${missing.length} записей — их нет у нас ни в каком виде.\n` +
        `      номера: ${missing.slice(0, 15).join(", ")}${missing.length > 15 ? " …" : ""}\n` +
        "      обычно это записи без клиента или без телефона: связать визит не с кем.",
    );
  } else {
    console.log("  ✓ все записи YCLIENTS есть у нас");
  }

  /**
   * Часы сверяем ТОЛЬКО по визитам, у которых состав услуг записан. Пока
   * состав заполнен не у всех (до полной выгрузки), сравнение всех часов с
   * частью состава показывало бы огромное «расхождение» на ровном месте.
   */
  console.log(`\n  часы визитов всего: ${hrs(visitMinutes)}`);
  if (withComposition === 0) {
    console.log("  состав услуг ещё не записан ни у одного визита — нужна полная выгрузка");
  } else {
    console.log(`  визитов с записанным составом: ${withComposition} из ${ours.length}`);
    console.log(`  их часы: ${hrs(composedVisitMinutes)}, по услугам: ${hrs(compositionMinutes)}`);
    const diff = compositionMinutes - composedVisitMinutes;
    console.log(
      diff === 0
        ? "  ✓ часы сходятся до минуты"
        : `  ✗ РАСХОЖДЕНИЕ ${diff} мин — разрезы покажут разные итоги`,
    );
  }
  if (withoutService > 0) console.log(`  визитов без услуги вовсе: ${withoutService}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
