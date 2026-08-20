/**
 * Почему голосовое не проигрывается.
 *
 * Цепочка есть целиком: вебхук Green API сохраняет ссылку на файл, `/api/media`
 * отдаёт его вошедшему сотруднику, инбокс рисует проигрыватель. Значит рвётся
 * одно звено, и надо узнать какое, а не гадать.
 *
 * Скрипт смотрит на вложения, которые у нас уже лежат: какого они вида, есть ли
 * у них ссылка и на каком она хосте. Хост важен: `/api/media` пускает только к
 * `green-api.com`, а файлы провайдер может отдавать со своего хранилища —
 * тогда наша же проверка и режет ссылку.
 *
 * Ничего не меняет. Тел сообщений и адресов целиком не печатает (§7): только
 * вид вложения, хост и длину ссылки.
 *
 *   npx tsx scripts/media-probe.ts
 *   npx tsx scripts/media-probe.ts --days=30
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { Prisma } from "../generated/prisma/client";

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

interface StoredAttachment {
  kind?: unknown;
  mimeType?: unknown;
  source?: { provider?: unknown; url?: unknown; fileId?: unknown };
}

function hostOf(raw: unknown): string {
  if (typeof raw !== "string") return "—";
  try {
    return new URL(raw).hostname;
  } catch {
    return "не адрес";
  }
}

async function main() {
  const days = Number(arg("days") ?? 90);
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const rows = await prisma.message.findMany({
    where: {
      conversation: { companyId: company.id },
      createdAt: { gte: since },
      // Пустое значение в JSON-поле Prisma отбирает своим маркером.
      NOT: { attachments: { equals: Prisma.DbNull } },
    },
    select: { id: true, createdAt: true, attachments: true, conversation: { select: { channel: true } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  console.log(`клиника: ${company.name}`);
  console.log(`сообщений с вложениями за ${days} дней: ${rows.length}\n`);

  const byKind = new Map<string, { total: number; withUrl: number; hosts: Map<string, number> }>();
  for (const m of rows) {
    const list = Array.isArray(m.attachments) ? (m.attachments as StoredAttachment[]) : [];
    for (const a of list) {
      const kind = typeof a.kind === "string" ? a.kind : "?";
      const acc = byKind.get(kind) ?? { total: 0, withUrl: 0, hosts: new Map<string, number>() };
      acc.total += 1;
      const url = a.source?.url;
      if (typeof url === "string" && url.length > 0) {
        acc.withUrl += 1;
        const h = hostOf(url);
        acc.hosts.set(h, (acc.hosts.get(h) ?? 0) + 1);
      }
      byKind.set(kind, acc);
    }
  }

  if (byKind.size === 0) {
    console.log("Вложений нет вовсе — значит вебхук их не приносит либо не сохраняет.");
  }
  console.log("── вложения по видам ──");
  for (const [kind, v] of [...byKind.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${kind}: ${v.total}, со ссылкой ${v.withUrl}, без ссылки ${v.total - v.withUrl}`);
    for (const [h, n] of [...v.hosts.entries()].sort((a, b) => b[1] - a[1])) {
      const allowed = /(^|\.)green-api\.com$/.test(h);
      console.log(`      хост ${h}: ${n}${allowed ? "  ✓ пропускаем" : "  ✗ /api/media РЕЖЕТ"}`);
    }
  }

  console.log(
    "\nЧто это значит:\n" +
      "  «без ссылки» — провайдер не прислал адрес файла в вебхуке, и достать его\n" +
      "  можно только отдельным запросом к Green API по идентификатору сообщения.\n" +
      "  «РЕЖЕТ» — ссылка есть, но наш обработчик её не пропускает: он ждёт хост\n" +
      "  green-api.com, а файл лежит в другом хранилище провайдера.",
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
