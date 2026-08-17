/**
 * Почему у диалога нет номера.
 *
 * В WhatsApp адрес чата и есть телефон — так было всегда. Но WhatsApp перешёл
 * на скрытые идентификаторы (вида «…@lid»), и в таком адресе номера нет вовсе:
 * ни показать администратору, ни найти карточку пациента по нему нельзя.
 *
 * Гадать, что именно присылает провайдер этой клинике, бессмысленно — скрипт
 * показывает настоящие адреса из базы: сколько диалогов с номером, сколько без,
 * какие у них окончания и привязаны ли карточки.
 *
 * Персональные данные не печатаем: от номера остаются последние четыре цифры.
 *
 *   npx tsx scripts/whatsapp-phones.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { phoneFromChatId } from "../lib/integrations/whatsapp/chat-id";

/** «79280001122@c.us» → «…1122@c.us»: опознать формат хватает, утечки нет. */
function mask(chatId: string): string {
  const at = chatId.indexOf("@");
  const head = at === -1 ? chatId : chatId.slice(0, at);
  const tail = at === -1 ? "" : chatId.slice(at);
  return `…${head.slice(-4)}${tail}`;
}

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const convs = await prisma.conversation.findMany({
    where: { companyId: company.id, channel: "WHATSAPP" },
    select: {
      externalUserId: true,
      patientId: true,
      contactName: true,
      lastMessageAt: true,
      _count: { select: { messages: true } },
    },
    orderBy: { lastMessageAt: "desc" },
  });

  console.log(`клиника: ${company.name}`);
  console.log(`диалогов WhatsApp: ${convs.length}`);

  const bySuffix = new Map<string, number>();
  let withPhone = 0;
  let linked = 0;

  for (const c of convs) {
    const at = c.externalUserId.indexOf("@");
    const suffix = at === -1 ? "(без @)" : c.externalUserId.slice(at);
    bySuffix.set(suffix, (bySuffix.get(suffix) ?? 0) + 1);
    if (phoneFromChatId(c.externalUserId)) withPhone += 1;
    if (c.patientId) linked += 1;
  }

  console.log(`\nформаты адреса:`);
  for (const [suffix, count] of [...bySuffix].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${suffix.padEnd(20)} ${count}`);
  }
  console.log(`\nномер удалось определить: ${withPhone} из ${convs.length}`);
  console.log(`привязано к карточке: ${linked} из ${convs.length}`);

  const problem = convs.filter((c) => !phoneFromChatId(c.externalUserId)).slice(0, 15);
  if (problem.length) {
    console.log(`\nдиалоги без номера (первые ${problem.length}):`);
    for (const c of problem) {
      console.log(
        `  ${mask(c.externalUserId).padEnd(24)} сообщений ${String(c._count.messages).padEnd(4)} ` +
          `карточка ${c.patientId ? "есть" : "нет"}` +
          (c.contactName ? `, ${c.contactName}` : ""),
      );
    }
  }

  /**
   * Что лежит в сыром вебхуке. Если провайдер присылает настоящий адрес
   * отдельным полем, номер можно достать и для скрытых идентификаторов — но
   * убедиться в этом нужно на живых данных, а не по документации.
   */
  const raw = await prisma.webhookEvent.findMany({
    where: { provider: "WHATSAPP" },
    orderBy: { receivedAt: "desc" },
    take: 5,
    select: { payload: true, receivedAt: true },
  });
  if (raw.length) {
    console.log(`\nпоследние события вебхука (senderData):`);
    for (const r of raw) {
      const data = (r.payload as { senderData?: Record<string, unknown> } | null)?.senderData;
      if (!data) continue;
      const shown: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        shown[k] = typeof v === "string" && v.includes("@") ? mask(v) : String(v).slice(0, 24);
      }
      console.log(`  ${r.receivedAt.toISOString().slice(0, 16)} ${JSON.stringify(shown)}`);
    }
  } else {
    console.log("\nсырых событий вебхука в базе нет — их не сохраняем для WhatsApp");
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("не удалось:", e);
  await prisma.$disconnect();
  process.exit(1);
});
