/**
 * Что происходило в диалоге: реплики и судьба каждого ответа.
 *
 * «Ассистент молчит, приходится дублировать» — жалоба, у которой две разные
 * причины, и внешне они неотличимы. Либо агент не ответил вовсе, либо ответил,
 * а канал сообщение не принял: в переписке у пациента пусто и там, и там.
 *
 * Разделяет их статус доставки, который мы храним у каждого своего сообщения:
 *
 *   SENT   — ушло пациенту;
 *   QUEUED — сочинено, но отправка ещё не подтверждена;
 *   FAILED — провайдер не принял, добор попробует ещё раз.
 *
 * Если напротив пропавшего ответа стоит FAILED — чинить надо доставку. Если
 * ответа нет вовсе — молчал сам агент, и смотреть надо в журнал.
 *
 * Тела сообщений печатает: без них по строке «OUT, SENT» ничего не понять, а
 * запускает скрипт сам владелец у себя на сервере (§7 — про внешние логи и
 * сторонние сервисы, здесь ни того, ни другого).
 *
 *   npx tsx scripts/dialog-trace.ts --phone=79280000000
 *   npx tsx scripts/dialog-trace.ts --last            # самый свежий диалог
 *   npx tsx scripts/dialog-trace.ts --last --limit=40
 */
import "dotenv/config";
import { prisma } from "../lib/db";

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const when = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

async function main() {
  const limit = Number(arg("limit") ?? 25);
  const phone = arg("phone");
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const conversation = await prisma.conversation.findFirst({
    where: {
      companyId: company.id,
      ...(phone ? { externalUserId: { contains: phone.replace(/\D/g, "") } } : {}),
    },
    orderBy: { lastMessageAt: "desc" },
    select: {
      id: true,
      channel: true,
      status: true,
      botPausedUntil: true,
      lastMessageAt: true,
      escalations: {
        where: { status: { not: "RESOLVED" } },
        select: { reason: true, createdAt: true },
      },
    },
  });
  if (!conversation) {
    console.log("Диалог не найден.");
    return;
  }

  console.log(`клиника: ${company.name}`);
  console.log(`диалог: ${conversation.channel}, статус ${conversation.status}`);
  if (conversation.botPausedUntil) {
    const active = conversation.botPausedUntil > new Date();
    console.log(
      `  пауза агента до ${when.format(conversation.botPausedUntil)}` +
        (active ? "  ← СЕЙЧАС АГЕНТ МОЛЧИТ" : " (истекла)"),
    );
  }
  for (const e of conversation.escalations) {
    console.log(`  открытая эскалация: ${e.reason} от ${when.format(e.createdAt)}`);
  }

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      createdAt: true,
      direction: true,
      authorType: true,
      status: true,
      isDraft: true,
      body: true,
    },
  });

  console.log(`\n── последние ${messages.length} сообщений ──`);
  for (const m of [...messages].reverse()) {
    const who = m.direction === "IN" ? "пациент" : m.authorType === "BOT" ? "агент  " : "человек";
    const mark =
      m.direction === "OUT"
        ? m.status === "SENT"
          ? "✓ доставлено"
          : m.status === "FAILED"
            ? "✗ НЕ ДОСТАВЛЕНО"
            : `· ${m.status}`
        : "";
    console.log(
      `  ${when.format(m.createdAt)}  ${who} ${m.isDraft ? "(черновик) " : ""}${mark}\n` +
        `      ${m.body.replace(/\n/g, " ").slice(0, 160)}`,
    );
  }

  const failed = messages.filter((m) => m.direction === "OUT" && m.status === "FAILED").length;
  const queued = messages.filter((m) => m.direction === "OUT" && m.status === "QUEUED").length;
  console.log("\n── что это значит ──");
  if (failed > 0) {
    console.log(
      `  ${failed} ответов не доставлено: агент их сочинил, канал не принял.\n` +
        "  Чинить надо доставку — причина будет в журнале рядом с «[whatsapp] ответ не доставлен».",
    );
  }
  if (queued > 0) {
    console.log(
      `  ${queued} ответов висят в очереди: отправка не подтверждена вовсе.\n` +
        "  Обычно это оборванный запрос к провайдеру.",
    );
  }
  if (failed === 0 && queued === 0) {
    console.log(
      "  Все ответы доставлены. Значит там, где пациент не получил ответа,\n" +
        "  агент промолчал сам — причина в журнале сервера, строки «[agent] …».",
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
