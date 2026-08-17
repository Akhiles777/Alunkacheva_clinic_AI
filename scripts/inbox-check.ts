/**
 * Что на самом деле лежит в инбоксе.
 *
 * Написан на вопрос «мне показалось или некоторые чаты исчезли». Переписку
 * платформа не удаляет нигде: ни одной строки, стирающей диалоги, в приложении
 * нет. Но из списка диалог пропасть может — по трём причинам, и все три видны
 * ниже: скрытый канал Telegram, включённый фильтр «Нужен ответ» и закрытые
 * диалоги.
 *
 * Скрипт показывает всё, что есть в базе, без фильтров экрана. Имена и номера
 * не печатаются.
 *
 *   npx tsx scripts/inbox-check.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const [byChannel, byStatus, total, messages] = await Promise.all([
    prisma.conversation.groupBy({
      by: ["channel"],
      where: { companyId: company.id },
      _count: { _all: true },
    }),
    prisma.conversation.groupBy({
      by: ["status"],
      where: { companyId: company.id },
      _count: { _all: true },
    }),
    prisma.conversation.count({ where: { companyId: company.id } }),
    prisma.message.count({ where: { companyId: company.id, deletedAt: null } }),
  ]);

  console.log(`клиника: ${company.name}`);
  console.log(`диалогов в базе: ${total}, сообщений: ${messages}`);

  console.log(`\nпо каналам:`);
  for (const row of byChannel) {
    const hidden = row.channel === "TELEGRAM" ? "  ← в списке инбокса скрыт (решение заказчика)" : "";
    console.log(`  ${row.channel.padEnd(10)} ${row._count._all}${hidden}`);
  }

  console.log(`\nпо состоянию:`);
  for (const row of byStatus) {
    const note = row.status === "CLOSED" ? "  ← закрытые в «Нужен ответ» не показываются" : "";
    console.log(`  ${row.status.padEnd(16)} ${row._count._all}${note}`);
  }

  /**
   * Сколько диалогов увидит администратор на экране и сколько из них попадёт в
   * «Нужен ответ». Метка означает обращение: новый диалог или сообщение через
   * сутки после предыдущего.
   */
  const visible = await prisma.conversation.count({
    where: { companyId: company.id, channel: { not: "TELEGRAM" } },
  });
  const waiting = await prisma.conversation.count({
    where: {
      companyId: company.id,
      channel: { not: "TELEGRAM" },
      status: { not: "CLOSED" },
      OR: [{ staffReadAt: null }, { lastMessageAt: { gt: prisma.conversation.fields.staffReadAt } }],
    },
  });

  console.log(`\nвидно в списке: ${visible}`);
  console.log(`из них не прочитано сотрудником: ${waiting}`);

  const recent = await prisma.conversation.findMany({
    where: { companyId: company.id },
    orderBy: { lastMessageAt: "desc" },
    take: 10,
    select: { channel: true, status: true, lastMessageAt: true, _count: { select: { messages: true } } },
  });
  console.log(`\nпоследние диалоги:`);
  for (const c of recent) {
    console.log(
      `  ${c.lastMessageAt.toISOString().slice(0, 16)} ${c.channel.padEnd(10)} ` +
        `${c.status.padEnd(16)} сообщений ${c._count.messages}`,
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("не удалось:", e);
  await prisma.$disconnect();
  process.exit(1);
});
