import { stat, statfs, access, constants } from "node:fs/promises";
import { prisma } from "../lib/db";
import { mediaRoot, pathOf } from "../lib/media/store";
import { loadCredentials } from "../lib/integrations/whatsapp/green-api";
import { GREEN_API_BASE } from "../lib/integrations/whatsapp/config";

/**
 * Почему перестали открываться вложения в «Диалогах» — разбор только на чтение.
 *
 * Вложение пациента в WhatsApp у нас не хранится: в сообщении лежит ссылка
 * провайдера, и `/api/media` каждый раз ходит по ней. Документация Green API
 * говорит, что срок хранения файлов ограничен, а срок ссылки виден в заголовке
 * `X-Amz-Expiration`. Этот разбор отвечает на три вопроса фактами:
 *
 *   1. Что отвечает провайдер по ссылкам вложений — по возрасту сообщения
 *      (запрос HEAD, сам файл не скачивается).
 *   2. Целы ли НАШИ файлы (что клиника отправляла пациентам) на диске.
 *   3. Отдаёт ли провайдер свежую ссылку методом downloadFile — только по
 *      `--refresh-one` и только для одного сообщения.
 *
 * Ничего не пишет и не отправляет. Имена и тексты пациентов не печатает.
 *
 *   npx tsx --env-file=.env scripts/media-check.ts [--days=30] [--refresh-one]
 */

const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 30);
const DAY = 24 * 3600_000;

async function head(url: string): Promise<{ status: number | string; expires: string | null; type: string | null; size: string | null }> {
  try {
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    return {
      status: r.status,
      expires: r.headers.get("x-amz-expiration") ?? r.headers.get("expires"),
      type: r.headers.get("content-type"),
      size: r.headers.get("content-length"),
    };
  } catch (e) {
    return { status: (e as Error).name, expires: null, type: null, size: null };
  }
}

async function main() {
  const since = new Date(Date.now() - DAYS * DAY);
  const rows = await prisma.message.findMany({
    where: { channel: "WHATSAPP", createdAt: { gte: since } },
    select: { id: true, companyId: true, createdAt: true, direction: true, externalId: true, attachments: true, conversation: { select: { externalUserId: true } } },
    orderBy: { createdAt: "desc" },
  });

  type Row = { age: number; kind: string; status: number | string; expires: string | null; provider: string };
  const checks: Row[] = [];
  let firstRemote: (typeof rows)[number] | null = null;
  for (const m of rows) {
    const list = Array.isArray(m.attachments) ? (m.attachments as Record<string, unknown>[]) : [];
    for (const a of list) {
      const source = (a?.source ?? {}) as { provider?: string; url?: string; mediaId?: string };
      const ageDays = Math.floor((Date.now() - m.createdAt.getTime()) / DAY);
      if (source.provider === "WHATSAPP" && source.url) {
        const h = await head(source.url);
        checks.push({ age: ageDays, kind: String(a.kind), status: h.status, expires: h.expires, provider: "WHATSAPP" });
        if (!firstRemote && m.direction === "IN" && m.externalId) firstRemote = m;
      } else {
        checks.push({ age: ageDays, kind: String(a.kind), status: source.provider ?? "нет источника", expires: null, provider: source.provider ?? "NONE" });
      }
    }
  }

  console.log(`\n1. Вложения WhatsApp за ${DAYS} дней: ${checks.length}`);
  const buckets: [string, (d: number) => boolean][] = [
    ["сегодня", (d) => d === 0],
    ["1–2 дня", (d) => d >= 1 && d <= 2],
    ["3–7 дней", (d) => d >= 3 && d <= 7],
    ["8–14 дней", (d) => d >= 8 && d <= 14],
    ["15+ дней", (d) => d >= 15],
  ];
  for (const [label, test] of buckets) {
    const xs = checks.filter((c) => c.provider === "WHATSAPP" && test(c.age));
    if (!xs.length) continue;
    const byStatus = new Map<string, number>();
    for (const x of xs) byStatus.set(String(x.status), (byStatus.get(String(x.status)) ?? 0) + 1);
    console.log(`   ${label.padEnd(10)} ${xs.length} шт. — ответ провайдера: ${[...byStatus].map(([s, n]) => `${s}×${n}`).join(", ")}`);
  }
  const withExpiry = checks.find((c) => c.expires);
  console.log(`   пример срока ссылки (X-Amz-Expiration / Expires): ${withExpiry?.expires ?? "заголовка нет"}`);
  const noSource = checks.filter((c) => c.provider !== "WHATSAPP" && c.provider !== "LOCAL");
  if (noSource.length) console.log(`   без ссылки вовсе (геопозиция, контакт или ссылку не прислали): ${noSource.length}`);

  console.log("\n2. Наши файлы на диске (отправленные клиникой)");
  const root = mediaRoot();
  console.log(`   каталог: ${root}`);
  try {
    await access(root, constants.W_OK);
    const fs = await statfs(root);
    console.log(`   запись разрешена, свободно ${Math.round((Number(fs.bavail) * Number(fs.bsize)) / 1024 / 1024)} МБ`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Каталог создаётся при первой отправке — его отсутствие ещё не поломка.
    console.log(
      code === "ENOENT"
        ? "   каталога ещё нет — создастся при первой отправке файла пациенту"
        : `   НЕДОСТУПЕН ДЛЯ ЗАПИСИ: ${(e as Error).message}`,
    );
  }
  const files = await prisma.mediaFile.findMany({ where: { createdAt: { gte: since } }, select: { storageId: true, sizeBytes: true, kind: true } });
  let missing = 0;
  for (const f of files) {
    try {
      await stat(pathOf(f.storageId));
    } catch {
      missing += 1;
    }
  }
  console.log(`   файлов за ${DAYS} дней: ${files.length}, не найдено на диске: ${missing}`);

  if (process.argv.includes("--refresh-one") && firstRemote) {
    console.log("\n3. Свежая ссылка через downloadFile (одно входящее сообщение)");
    const creds = await loadCredentials(firstRemote.companyId);
    if (!creds) {
      console.log("   ключи Green API не найдены");
    } else {
      const r = await fetch(`${GREEN_API_BASE}/waInstance${creds.idInstance}/downloadFile/${creds.apiToken}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId: firstRemote.conversation.externalUserId, idMessage: firstRemote.externalId }),
        signal: AbortSignal.timeout(20_000),
      }).catch((e) => e as Error);
      if (r instanceof Error) {
        console.log(`   запрос упал: ${r.name}`);
      } else {
        const body = (await r.json().catch(() => ({}))) as { downloadUrl?: string };
        console.log(`   ответ ${r.status}, ссылка ${body.downloadUrl ? "получена" : "НЕ получена"}`);
        if (body.downloadUrl) {
          const h = await head(body.downloadUrl);
          console.log(`   по свежей ссылке провайдер отвечает: ${h.status}, срок: ${h.expires ?? "не указан"}`);
        }
      }
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
