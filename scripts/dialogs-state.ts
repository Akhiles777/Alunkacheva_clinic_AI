/**
 * Почему диалог не у агента.
 *
 * Возврат через сутки тишины делает круг расписания, и увидеть его работу
 * изнутри нельзя: на экране просто есть или нет кнопка «вернуть агенту».
 * Скрипт показывает по каждому диалогу то же, что видит правило: сколько он
 * молчит, кто сказал последнее слово и заберёт ли его агент на ближайшем
 * круге.
 *
 * Ничего не меняет. Имён и текстов сообщений не печатает (§7).
 *
 *   npx tsx scripts/dialogs-state.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { shouldHandBack, shouldRemind, HANDBACK_HOURS, REMIND_AFTER_MIN } from "../lib/agent/handback-rule";

const hours = (ms: number) => (ms / 3600_000).toFixed(1);

async function main() {
  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  const now = new Date();
  console.log(`клиника: ${company.name}`);
  console.log(`правило: возврат агенту после ${HANDBACK_HOURS} ч тишины, напоминание через ${REMIND_AFTER_MIN} мин\n`);

  const byStatus = await prisma.conversation.groupBy({
    by: ["status"],
    where: { companyId: company.id },
    _count: { _all: true },
  });
  console.log("── диалоги по статусам ──");
  for (const r of byStatus) console.log(`  ${r.status}: ${r._count._all}`);

  const dialogs = await prisma.conversation.findMany({
    where: { companyId: company.id, status: { in: ["HUMAN_TAKEOVER", "ESCALATED"] } },
    orderBy: { lastMessageAt: "asc" },
    select: {
      id: true,
      status: true,
      remindedAt: true,
      reminderCount: true,
      lastMessageAt: true,
      messages: {
        where: { deletedAt: null, isDraft: false },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { direction: true, createdAt: true },
      },
      escalations: { where: { status: { not: "RESOLVED" } }, select: { id: true } },
    },
  });

  console.log(`\n── не у агента: ${dialogs.length} ──`);
  let willReturn = 0;
  let willRemind = 0;
  let noMessages = 0;

  for (const d of dialogs) {
    const last = d.messages[0];
    if (!last) {
      noMessages += 1;
      console.log(`  ${d.status} · сообщений нет — правило такой диалог не трогает`);
      continue;
    }
    const silent = now.getTime() - last.createdAt.getTime();
    const back = shouldHandBack(last, now);
    const remind = shouldRemind(
      { last, remindedAt: d.remindedAt, reminderCount: d.reminderCount },
      now,
    );
    if (back) willReturn += 1;
    if (remind) willRemind += 1;

    console.log(
      `  ${d.status} · молчит ${hours(silent)} ч · последним ${last.direction === "IN" ? "писал пациент" : "отвечали мы"}` +
        `${d.escalations.length ? " · эскалация открыта" : ""}` +
        `${d.reminderCount ? ` · напоминаний ${d.reminderCount}` : ""}` +
        ` → ${back ? "ВЕРНЁТСЯ агенту" : remind ? "НАПОМНИМ" : "остаётся у человека"}`,
    );
  }

  console.log(
    `\nна ближайшем круге: вернётся ${willReturn}, напоминаний ${willRemind}` +
      `${noMessages ? `, без сообщений ${noMessages}` : ""}`,
  );
  if (dialogs.length > 0 && willReturn === 0 && willRemind === 0) {
    console.log(
      "Ничего не сработает — и это не поломка: значит ни один диалог не молчит\n" +
        `${HANDBACK_HOURS} часов и ни в одном пациент не ждёт дольше ${REMIND_AFTER_MIN} минут.`,
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
