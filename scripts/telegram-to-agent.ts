/**
 * Вернуть диалоги агенту.
 *
 * Диалог замолкает по трём причинам: сотрудник ответил вручную (пауза 12 часов),
 * администратор ведёт передачу (открытая эскалация) или бот сам себя перебил
 * эхом собственного ответа — так было до правки в разборе исходящих. Кнопка
 * «Вернуть агенту» в инбоксе снимает это по одному диалогу; когда таких
 * диалогов десятки, нужен один проход.
 *
 * Что делает: снимает паузу, закрывает эскалации и возвращает статус BOT_ACTIVE.
 * Переписку не трогает — она остаётся как есть.
 *
 *   npx tsx scripts/telegram-to-agent.ts            # Telegram, показать план
 *   npx tsx scripts/telegram-to-agent.ts --apply    # выполнить
 *   npx tsx scripts/telegram-to-agent.ts --apply --channel=WHATSAPP
 *   npx tsx scripts/telegram-to-agent.ts --apply --channel=ALL
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import type { Prisma } from "../generated/prisma/client";

type Channel = "TELEGRAM" | "WHATSAPP" | "INSTAGRAM";

function channelArg(): Channel | "ALL" {
  const raw = process.argv.find((a) => a.startsWith("--channel="))?.split("=")[1]?.toUpperCase();
  if (raw === "ALL") return "ALL";
  if (raw === "WHATSAPP" || raw === "INSTAGRAM" || raw === "TELEGRAM") return raw;
  // По умолчанию Telegram: с него и просили начать.
  return "TELEGRAM";
}

async function main() {
  const apply = process.argv.includes("--apply");
  const channel = channelArg();
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const where: Prisma.ConversationWhereInput = {
    companyId: company.id,
    ...(channel === "ALL" ? {} : { channel }),
    // Закрытые диалоги не трогаем: их закрыли осознанно.
    status: { in: ["ESCALATED", "HUMAN_TAKEOVER"] },
  };

  const convs = await prisma.conversation.findMany({
    where,
    select: {
      id: true,
      channel: true,
      status: true,
      botPausedUntil: true,
      contactName: true,
      lastMessageAt: true,
      _count: { select: { escalations: { where: { status: { not: "RESOLVED" } } } } },
    },
    orderBy: { lastMessageAt: "desc" },
  });

  console.log(`клиника: ${company.name}`);
  console.log(`канал: ${channel}`);
  console.log(`диалогов под управлением человека: ${convs.length}`);
  for (const c of convs.slice(0, 30)) {
    console.log(
      `  ${c.channel.padEnd(9)} ${c.status.padEnd(15)} ` +
        `эскалаций ${c._count.escalations}, последнее ${c.lastMessageAt.toISOString().slice(0, 16)}` +
        (c.contactName ? `, ${c.contactName}` : ""),
    );
  }
  if (convs.length > 30) console.log(`  … и ещё ${convs.length - 30}`);

  if (!apply) {
    console.log("\nэто предварительный просмотр. чтобы выполнить: --apply");
    await prisma.$disconnect();
    return;
  }
  if (convs.length === 0) {
    await prisma.$disconnect();
    return;
  }

  const ids = convs.map((c) => c.id);
  const now = new Date();

  const [escalations, updated] = await prisma.$transaction([
    prisma.escalation.updateMany({
      where: { conversationId: { in: ids }, status: { not: "RESOLVED" } },
      data: { status: "RESOLVED", resolvedAt: now },
    }),
    prisma.conversation.updateMany({
      where: { id: { in: ids } },
      data: { status: "BOT_ACTIVE", botPausedUntil: null },
    }),
  ]);

  console.log(`\nвернули агенту: ${updated.count}, закрыли эскалаций: ${escalations.count}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("не удалось:", e);
  await prisma.$disconnect();
  process.exit(1);
});
