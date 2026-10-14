import { prisma } from "../lib/db";
import { cacheMessageAttachments } from "../lib/media/remote-cache";

/**
 * Сохранить у себя вложения пациентов, пришедшие до правки, — пока провайдер
 * их ещё отдаёт.
 *
 * Новые файлы сохраняются сами при получении, а старые — при первом открытии.
 * Этот разбор делает то же заранее: ссылка Green API истекает, и вложение,
 * которое никто не открыл вовремя, потом уже не достать.
 *
 * По умолчанию только считает. `--apply` — сохраняет (по одному сообщению,
 * чтобы не занимать память сервера), ничего не отправляет пациентам.
 *
 *   npx tsx --env-file=.env scripts/media-cache.ts [--days=30] [--apply]
 */

const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 30);
const APPLY = process.argv.includes("--apply");

async function main() {
  const since = new Date(Date.now() - DAYS * 24 * 3600_000);
  const rows = await prisma.message.findMany({
    where: { channel: "WHATSAPP", createdAt: { gte: since } },
    select: { id: true, attachments: true },
    orderBy: { createdAt: "desc" },
  });
  const pending = rows.filter(
    (m) =>
      Array.isArray(m.attachments) &&
      (m.attachments as { source?: { provider?: string } }[]).some((a) => a?.source?.provider === "WHATSAPP"),
  );
  console.log(`Сообщений с файлом только по ссылке провайдера за ${DAYS} дней: ${pending.length}`);
  if (!APPLY) {
    console.log("Сухой прогон. С --apply файлы будут сохранены у нас.");
    return;
  }
  let saved = 0;
  let lost = 0;
  for (const m of pending) {
    const n = await cacheMessageAttachments(m.id).catch(() => 0);
    if (n > 0) saved += n;
    else lost += 1;
  }
  console.log(`Сохранено файлов: ${saved}. Провайдер уже не отдаёт: ${lost} сообщений.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
