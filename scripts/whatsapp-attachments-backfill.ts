/**
 * Вернуть вложения сообщениям, у которых остались одни подписи.
 *
 * Исходящие сообщения WhatsApp сохранялись без файлов: сотрудник отправлял с
 * телефона две фотографии, в переписке оставалось «[фотография] [фотография]
 * подпись», а открыть было нечего. История чата теряла файлы по той же
 * причине. Обе дыры закрыты, но уже записанные сообщения так и лежат без
 * вложений — их и добираем.
 *
 * Берём историю чата у провайдера и сопоставляем по идентификатору сообщения:
 * это точное совпадение, без догадок. Чего в истории нет (провайдер хранит её
 * не вечно) — оставляем как есть и называем числом.
 *
 * Ничего не удаляет и текст не трогает. Имён и телефонов не печатает (§7).
 *
 *   npx tsx scripts/whatsapp-attachments-backfill.ts          — показать план
 *   npx tsx scripts/whatsapp-attachments-backfill.ts --apply
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { fetchChatHistory } from "../lib/integrations/whatsapp/green-api";
import { Prisma } from "../generated/prisma/client";

const APPLY = process.argv.includes("--apply");
/** Сколько сообщений истории просить у провайдера на один чат. */
const HISTORY_COUNT = 500;

async function main() {
  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  console.log(`клиника: ${company.name}`);
  console.log(APPLY ? "режим: запись\n" : "режим: только показать (--apply чтобы записать)\n");

  /**
   * Сообщения с нашей пометкой о вложении, но без самих вложений. Пометку
   * ставит messageBody: «[фотография]», «[голосовое сообщение]».
   */
  const orphans = await prisma.message.findMany({
    where: {
      companyId: company.id,
      channel: "WHATSAPP",
      deletedAt: null,
      attachments: { equals: Prisma.DbNull },
      body: { startsWith: "[" },
      externalId: { not: null },
    },
    select: {
      id: true,
      externalId: true,
      createdAt: true,
      conversation: { select: { id: true, externalUserId: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  if (orphans.length === 0) {
    console.log("✓ сообщений без вложений нет — добирать нечего");
    await prisma.$disconnect();
    return;
  }

  const byChat = new Map<string, typeof orphans>();
  for (const m of orphans) {
    const chat = m.conversation.externalUserId;
    byChat.set(chat, [...(byChat.get(chat) ?? []), m]);
  }
  console.log(`сообщений без вложений: ${orphans.length} в ${byChat.size} диалогах\n`);

  let filled = 0;
  let missing = 0;
  for (const [chatId, list] of byChat) {
    let history;
    try {
      history = await fetchChatHistory(company.id, chatId, HISTORY_COUNT);
    } catch (e) {
      console.log(`  чат …${chatId.slice(-8)}: история не прочиталась (${(e as Error).message})`);
      missing += list.length;
      continue;
    }
    const byId = new Map(history.map((h) => [h.externalId, h]));

    for (const m of list) {
      const found = m.externalId ? byId.get(m.externalId) : undefined;
      if (!found || found.attachments.length === 0) {
        missing += 1;
        continue;
      }
      filled += 1;
      if (APPLY) {
        await prisma.message.update({
          where: { id: m.id },
          data: { attachments: found.attachments as unknown as object[] },
        });
      }
    }
    console.log(`  чат …${chatId.slice(-8)}: сообщений ${list.length}, история ${history.length}`);
  }

  console.log(
    `\n${APPLY ? "восстановлено" : "можно восстановить"}: ${filled}` +
      `\nне нашлось у провайдера: ${missing}` +
      (missing > 0
        ? "\n  Историю провайдер хранит не вечно: у таких сообщений останется одна подпись."
        : ""),
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
