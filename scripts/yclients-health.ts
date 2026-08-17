/**
 * Почему приёмов много, а «пришедших» один.
 *
 * Статус посещения проставляет администратор в YCLIENTS, мы его только читаем
 * (§2). Значит цепочка длинная, и оборваться она может в четырёх местах:
 *
 *   1. Синхронизация давно не запускалась — статусы застыли на дате выгрузки.
 *   2. Вебхуки YCLIENTS не настроены или не доходят — об изменениях не узнаём.
 *   3. Окно догона считается по дате визита: визит, отмеченный задним числом,
 *      в окно не попадает и остаётся с прежним статусом навсегда.
 *   4. Поле посещаемости в ответе называется иначе, чем мы читаем, — тогда все
 *      визиты остаются в статусе «создана».
 *
 * Скрипт проверяет все четыре, печатая факты, а не догадки: когда была
 * последняя синхронизация, приходят ли вебхуки, как распределены статусы у нас
 * и что на самом деле лежит в ответе YCLIENTS по тем же записям.
 *
 * Персональные данные не печатаются: только идентификаторы, даты и статусы.
 *
 *   npx tsx scripts/yclients-health.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { getYclientsClient } from "../lib/integrations/yclients/client";
import { ENDPOINTS } from "../lib/integrations/yclients/config";

function ago(date: Date | null | undefined): string {
  if (!date) return "никогда";
  const hours = Math.round((Date.now() - date.getTime()) / 3600_000);
  if (hours < 48) return `${date.toISOString().slice(0, 16)} (${hours} ч назад)`;
  return `${date.toISOString().slice(0, 16)} (${Math.round(hours / 24)} дн назад)`;
}

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  console.log(`клиника: ${company.name}, филиал YCLIENTS: ${company.yclientsId ?? "не задан"}`);

  // ── 1. Когда синхронизировались
  const cursors = await prisma.syncCursor.findMany({
    where: { companyId: company.id },
    orderBy: { entity: "asc" },
    select: { entity: true, lastSyncedAt: true, lastCursor: true },
  });
  console.log(`\n═══ СИНХРОНИЗАЦИЯ ═══`);
  if (cursors.length === 0) {
    console.log("  курсоров нет — полная выгрузка ни разу не доходила до конца");
  }
  for (const c of cursors) {
    console.log(`  ${c.entity.padEnd(10)} ${ago(c.lastSyncedAt)}`);
  }

  // ── 2. Вебхуки
  const [hookCount, lastHook, byType] = await Promise.all([
    prisma.webhookEvent.count({ where: { companyId: company.id, provider: "YCLIENTS" } }),
    prisma.webhookEvent.findFirst({
      where: { companyId: company.id, provider: "YCLIENTS" },
      orderBy: { receivedAt: "desc" },
      select: { receivedAt: true, eventType: true, status: true },
    }),
    prisma.webhookEvent.groupBy({
      by: ["eventType", "status"],
      where: { companyId: company.id, provider: "YCLIENTS" },
      _count: { _all: true },
    }),
  ]);
  console.log(`\n═══ ВЕБХУКИ YCLIENTS ═══`);
  console.log(`  всего событий: ${hookCount}; последнее: ${ago(lastHook?.receivedAt ?? null)}`);
  for (const row of byType) {
    console.log(`  ${row.eventType.padEnd(24)} ${row.status.padEnd(10)} ${row._count._all}`);
  }
  if (hookCount === 0) {
    console.log("  ВНИМАНИЕ: ни одного события. Отметка «пришёл» до нас не доходит,");
    console.log("  статусы меняются только при ручной синхронизации.");
  }

  // ── 3. Что у нас в базе
  const byStatus = await prisma.appointment.groupBy({
    by: ["status"],
    where: { companyId: company.id, deletedAt: null },
    _count: { _all: true },
  });
  const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const recent = await prisma.appointment.groupBy({
    by: ["status"],
    where: { companyId: company.id, deletedAt: null, startAt: { gte: monthAgo, lte: new Date() } },
    _count: { _all: true },
  });
  console.log(`\n═══ СТАТУСЫ ВИЗИТОВ У НАС ═══`);
  console.log("  за всё время:");
  for (const row of byStatus) console.log(`    ${row.status.padEnd(12)} ${row._count._all}`);
  console.log("  за последние 30 дней (прошедшие):");
  for (const row of recent) console.log(`    ${row.status.padEnd(12)} ${row._count._all}`);

  // ── 4. Что отдаёт YCLIENTS по тем же записям
  const client = await getYclientsClient(company.id);
  if (!client) {
    console.log("\nключи YCLIENTS не заданы — сравнить с источником нечем");
    await prisma.$disconnect();
    return;
  }

  const apiDate = (d: Date) => d.toISOString().slice(0, 10);
  const page = await client
    .getPage<Record<string, unknown>[]>(ENDPOINTS.records(String(company.yclientsId ?? "")), {
      start_date: apiDate(monthAgo),
      end_date: apiDate(new Date()),
      count: 50,
      page: 1,
    })
    .catch((e: unknown) => {
      console.log(`\nзапрос записей не удался: ${(e as Error).message}`);
      return null;
    });

  if (!page) {
    await prisma.$disconnect();
    return;
  }

  const records = Array.isArray(page.data) ? page.data : [];
  console.log(`\n═══ ОТВЕТ YCLIENTS (${records.length} записей за 30 дней) ═══`);
  if (records.length === 0) {
    console.log("  записей нет — сравнивать не с чем");
    await prisma.$disconnect();
    return;
  }

  /**
   * Какие поля про посещаемость вообще есть в ответе. Мы читаем
   * visit_attendance; если провайдер называет его иначе, все визиты остаются
   * «созданными» — и «пришедших» в отчётах не появится никогда.
   */
  const keys = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (/attend|confirm|delet|status|visit/i.test(k)) keys.add(k);
    }
  }
  console.log(`  поля про посещение в ответе: ${[...keys].join(", ") || "нет ни одного"}`);

  const counts = new Map<string, number>();
  for (const r of records) {
    const v = String((r as { visit_attendance?: unknown }).visit_attendance ?? "нет поля");
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  console.log(`  значения visit_attendance: ${[...counts].map(([k, v]) => `${k} → ${v}`).join(", ")}`);

  // Сверяем построчно: что у нас против того, что в источнике.
  const ids = records.map((r) => Number((r as { id?: unknown }).id)).filter(Number.isFinite);
  const ours = await prisma.appointment.findMany({
    where: { companyId: company.id, yclientsRecordId: { in: ids } },
    select: { yclientsRecordId: true, status: true, startAt: true },
  });
  const ourById = new Map(ours.map((a) => [a.yclientsRecordId, a]));

  let mismatched = 0;
  let missing = 0;
  const EXPECTED: Record<string, string> = { "-1": "NO_SHOW", "1": "ARRIVED", "2": "CONFIRMED", "0": "CREATED" };
  console.log(`\n  расхождения (наш статус против источника):`);
  for (const r of records) {
    const id = Number((r as { id?: unknown }).id);
    const raw = String((r as { visit_attendance?: unknown }).visit_attendance ?? "0");
    const expected = EXPECTED[raw] ?? "CREATED";
    const our = ourById.get(id);
    if (!our) {
      missing += 1;
      continue;
    }
    if (our.status !== expected) {
      mismatched += 1;
      if (mismatched <= 15) {
        console.log(
          `    запись ${id}: у нас ${our.status.padEnd(10)} в YCLIENTS ${expected.padEnd(10)} ` +
            `(${our.startAt.toISOString().slice(0, 10)})`,
        );
      }
    }
  }
  console.log(
    `\n  сверено ${records.length}: расходится ${mismatched}, нет у нас ${missing}, ` +
      `совпадает ${records.length - mismatched - missing}`,
  );
  if (mismatched > 0) {
    console.log("  Расхождение означает, что изменение статуса до платформы не дошло.");
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("проверка упала:", e);
  await prisma.$disconnect();
  process.exit(1);
});
