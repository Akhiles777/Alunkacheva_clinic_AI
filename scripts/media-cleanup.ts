/**
 * Убрать заброшенные загрузки.
 *
 * Администратор выбрал файл и передумал — закрыл вкладку, ушёл в другой
 * диалог. Файл к этому моменту уже на диске, а к сообщению не привязан и
 * никогда не будет: отправка принимает только те, что выбраны сейчас.
 * Такие и убираем.
 *
 *   npx tsx scripts/media-cleanup.ts            # только показать
 *   npx tsx scripts/media-cleanup.ts --apply
 *
 * Сухой прогон по умолчанию. Файл, ушедший пациенту, не трогаем ни при каких
 * условиях: он часть переписки, и переписку мы не переписываем задним числом.
 * Строка в базе остаётся с пометкой удаления (§«физическое удаление
 * запрещено»), с диска уходят только байты — и только у заброшенных.
 */
import "dotenv/config";
import { unlink } from "node:fs/promises";
import { prisma } from "../lib/db";
import { pathOf } from "../lib/media/store";

/** Сколько ждём, прежде чем считать загрузку заброшенной. */
const ABANDONED_HOURS = 24;

async function main() {
  const apply = process.argv.includes("--apply");
  const before = new Date(Date.now() - ABANDONED_HOURS * 3600 * 1000);

  const rows = await prisma.mediaFile.findMany({
    where: { messageId: null, deletedAt: null, createdAt: { lt: before } },
    select: { id: true, storageId: true, fileName: true, sizeBytes: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const total = rows.reduce((s, r) => s + r.sizeBytes, 0);
  console.log(`заброшенных загрузок старше ${ABANDONED_HOURS} ч: ${rows.length}`);
  console.log(`освободится: ${(total / (1024 * 1024)).toFixed(1)} МБ`);
  for (const r of rows.slice(0, 20)) {
    console.log(`  ${r.createdAt.toISOString().slice(0, 16)}  ${r.fileName ?? "без имени"}  → удалим`);
  }
  if (rows.length > 20) console.log(`  … и ещё ${rows.length - 20}`);

  const kept = await prisma.mediaFile.count({ where: { messageId: { not: null }, deletedAt: null } });
  console.log(`отправленных файлов (не трогаем): ${kept}`);

  if (!apply) {
    console.log("\nсухой прогон: ничего не удалено");
    console.log("удалить по-настоящему: npx tsx scripts/media-cleanup.ts --apply");
    return;
  }

  let removed = 0;
  for (const r of rows) {
    try {
      await unlink(pathOf(r.storageId));
    } catch {
      // Файла уже нет — значит и убирать нечего; пометку всё равно ставим.
    }
    await prisma.mediaFile.update({ where: { id: r.id }, data: { deletedAt: new Date() } });
    removed += 1;
  }
  console.log(`\nубрано: ${removed}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
