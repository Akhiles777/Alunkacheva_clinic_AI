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

  /**
   * Доставка ответов — по каналам.
   *
   * «Бот иногда не отвечает» бывает двух совершенно разных сортов: агент не
   * составил ответ (тогда сообщения нет вовсе) или составил, а провайдер его
   * не принял (сообщение есть, но осталось в очереди). Различить их по экрану
   * нельзя — в инбоксе ответ виден в обоих случаях, а у пациента его нет.
   *
   * Считаем по последней неделе: старое всё равно уже не доставить.
   */
  const week = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const outgoing = await prisma.message.groupBy({
    by: ["channel", "status"],
    where: {
      companyId: company.id,
      direction: "OUT",
      deletedAt: null,
      isDraft: false,
      createdAt: { gte: week },
    },
    _count: { _all: true },
  });

  console.log("\nответы за неделю — по каналам:");
  const outgoingByChannel = new Map<string, Map<string, number>>();
  for (const r of outgoing) {
    const m = outgoingByChannel.get(r.channel) ?? new Map<string, number>();
    m.set(r.status, r._count._all);
    outgoingByChannel.set(r.channel, m);
  }
  if (outgoingByChannel.size === 0) {
    console.log("  ответов за неделю не было");
  }
  for (const [channel, statuses] of outgoingByChannel) {
    const total = [...statuses.values()].reduce((a, b) => a + b, 0);
    const stuck = (statuses.get("QUEUED") ?? 0) + (statuses.get("FAILED") ?? 0);
    console.log(
      `  ${channel.padEnd(10)} всего ${String(total).padStart(4)} · ` +
        [...statuses.entries()].map(([st, n]) => `${st} ${n}`).join(", ") +
        (stuck > 0 ? `  ← ${stuck} не доставлено` : "  ✓"),
    );
  }
  console.log(
    "  QUEUED/FAILED означает, что ответ агент составил, а провайдер его не принял:\n" +
      "  в переписке он есть, у пациента — нет. Молчание агента выглядит так же,\n" +
      "  но там ответа нет и в базе.",
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("не удалось:", e);
  await prisma.$disconnect();
  process.exit(1);
});
