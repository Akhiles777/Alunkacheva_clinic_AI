/**
 * Перечитать историю из YCLIENTS заново.
 *
 * Обычная выгрузка инкрементальная: она берёт последний месяц и всё, что
 * изменилось с прошлого раза. Этого достаточно каждый день, но не тогда, когда
 * мы начали читать новое поле — тогда старые записи остаются с прежними
 * значениями, потому что заново их никто не запрашивает.
 *
 * Так вышло с датой создания записи: до сегодняшнего дня в неё писалась дата
 * визита, и метрика «записались за период» на истории показывает приёмы, а не
 * записи. Один полный проход это чинит.
 *
 * Сбрасывает курсор и запускает выгрузку с нуля — на несколько лет истории это
 * сотни запросов к YCLIENTS и несколько минут. Делать по необходимости, а не по
 * расписанию.
 *
 *   npx tsx scripts/yclients-resync.ts           # показать, что будет сделано
 *   npx tsx scripts/yclients-resync.ts --apply
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { syncAll } from "../lib/integrations/yclients/sync";
import { recomputeVisitKinds, backfillRooms, backfillFirstSeen } from "../lib/metrics/recompute";

async function main() {
  const apply = process.argv.includes("--apply");
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const cursors = await prisma.syncCursor.findMany({
    where: { companyId: company.id },
    select: { entity: true, lastSyncedAt: true },
    orderBy: { entity: "asc" },
  });

  console.log(`клиника: ${company.name}`);
  console.log(`курсоры сейчас:`);
  for (const c of cursors) {
    console.log(`  ${c.entity.padEnd(10)} ${c.lastSyncedAt?.toISOString().slice(0, 16) ?? "—"}`);
  }

  if (!apply) {
    console.log(`\nбудет сделано: курсор RECORDS сброшен, история перечитана с нуля,`);
    console.log(`первичность визитов пересчитана. Чтобы выполнить: --apply`);
    await prisma.$disconnect();
    return;
  }

  // Сбрасываем только записи: клиенты, услуги и сотрудники и так перечитываются
  // целиком каждый раз, а история визитов — единственное, что читается окнами.
  await prisma.syncCursor.deleteMany({ where: { companyId: company.id, entity: "RECORDS" } });
  console.log(`\nкурсор RECORDS сброшен, читаем историю заново…`);

  const started = Date.now();
  const result = await syncAll(company.id);
  console.log(`выгрузка: ${JSON.stringify(result.counts)}`);
  if (result.errors.length > 0) console.log(`ошибки: ${result.errors.join("; ")}`);

  const [kinds, rooms, firstSeen] = await Promise.all([
    recomputeVisitKinds(company.id),
    backfillRooms(company.id),
    backfillFirstSeen(company.id),
  ]);
  console.log(
    `пересчёт: видов визитов ${kinds.updated}, кабинетов проставлено ${rooms}, ` +
      `дат первого обращения исправлено ${firstSeen}`,
  );
  console.log(`заняло ${Math.round((Date.now() - started) / 1000)} с`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("не удалось:", e);
  await prisma.$disconnect();
  process.exit(1);
});
