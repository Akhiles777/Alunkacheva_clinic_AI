/**
 * Найти переписки, которых на самом деле не было.
 *
 * До сегодняшней правки кнопка «Написать» (курсы, «Кому позвонить», инбокс)
 * только записывала сообщение в базу: заводила диалог с выдуманным адресом
 * `local-…` и показывала «Сообщение отправлено». Пациент не получал ничего.
 *
 * Такие диалоги надо увидеть глазами: администратор считает, что этим людям
 * написали, и больше к ним не возвращается. Скрипт называет их поимённо и
 * показывает тексты, которые не ушли.
 *
 *   npx tsx scripts/local-dialogs.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const rows = await prisma.conversation.findMany({
    where: { companyId: company.id, externalUserId: { startsWith: "local-" } },
    select: {
      id: true,
      channel: true,
      startedAt: true,
      patient: { select: { name: true, phones: { select: { phone: true }, take: 1 } } },
      messages: {
        where: { deletedAt: null },
        select: { direction: true, body: true, createdAt: true, status: true },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { startedAt: "desc" },
  });

  console.log(`клиника: ${company.name}`);
  if (rows.length === 0) {
    console.log("недоставленных диалогов нет — все переписки настоящие");
    return;
  }

  console.log(`\nдиалогов, созданных мимо провайдера: ${rows.length}`);
  console.log("пациент получил их ТОЛЬКО если писал сам в настоящий чат\n");

  for (const c of rows) {
    const phone = c.patient?.phones[0]?.phone ?? "нет номера";
    const at = c.startedAt.toISOString().slice(0, 16).replace("T", " ");
    console.log(`— ${c.patient?.name ?? "без карточки"} · ${phone} · ${c.channel} · ${at}`);
    for (const m of c.messages) {
      const who = m.direction === "OUT" ? "мы" : "пациент";
      console.log(`    ${who}: ${m.body.slice(0, 120).replace(/\s+/g, " ")}`);
    }
  }

  /**
   * Входящие в таких диалогах означают, что пациент всё-таки писал — значит
   * настоящая переписка с ним где-то есть, и эти две надо свести.
   */
  const withInbound = rows.filter((c) => c.messages.some((m) => m.direction === "IN")).length;
  console.log(
    `\nиз них с ответом пациента: ${withInbound} — у этих людей есть и настоящая переписка`,
  );
  console.log("остальным клиника НЕ написала, хотя экран показывал «отправлено»");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
