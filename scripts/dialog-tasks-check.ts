/**
 * Проверка отложенных отправок — на живой песочнице.
 *
 * Чистая логика здесь короткая, а цена ошибки высокая: сообщение, ушедшее
 * пациенту дважды, и сообщение, не ушедшее вовсе, выглядят одинаково —
 * задача в базе помечена. Проверяем ровно это:
 *
 *   — назревшая задача исполняется;
 *   — второй прогон (а круг выгрузки идёт каждые три минуты) не отправляет
 *     то же самое повторно;
 *   — неудача записывается словами, а не теряется;
 *   — задача с будущим временем не трогается.
 *
 *   npx tsx scripts/dialog-tasks-check.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { runDueDialogTasks } from "../app/(dashboard)/inbox/dialog-actions";
import { SANDBOX_YCLIENTS_ID } from "./sandbox-id";

const PREFIX = "task-check-";

async function assertSandbox() {
  const live = await prisma.company.findFirst({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  if (!live) return;
  const visits = await prisma.appointment.count({ where: { companyId: live.id } });
  if (visits > 0) {
    console.error(`ЭТО БОЕВАЯ БАЗА: клиника «${live.name}», визитов ${visits}. Проверка не идёт.`);
    process.exit(1);
  }
}

async function main() {
  await assertSandbox();
  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: SANDBOX_YCLIENTS_ID },
    select: { id: true },
  });
  const companyId = company.id;

  await prisma.dialogTask.deleteMany({ where: { id: { startsWith: PREFIX } } });
  const conv = await prisma.conversation.upsert({
    where: {
      companyId_channel_externalUserId: {
        companyId,
        channel: "WHATSAPP",
        externalUserId: PREFIX + "chat",
      },
    },
    update: {},
    create: {
      companyId,
      channel: "WHATSAPP",
      externalUserId: PREFIX + "chat",
      contactName: "Проверка отложенных",
      status: "HUMAN_TAKEOVER",
      startedAt: new Date(),
      lastMessageAt: new Date(),
    },
    select: { id: true },
  });

  const past = await prisma.dialogTask.create({
    data: {
      id: PREFIX + "due",
      companyId,
      conversationId: conv.id,
      kind: "SEND",
      body: "Доброе утро! Это отложенное сообщение.",
      runAt: new Date(Date.now() - 60_000),
    },
    select: { id: true },
  });
  await prisma.dialogTask.create({
    data: {
      id: PREFIX + "future",
      companyId,
      conversationId: conv.id,
      kind: "SEND",
      body: "Это должно ждать своего часа.",
      runAt: new Date(Date.now() + 3600_000),
    },
  });

  const first = await runDueDialogTasks(companyId);
  const afterFirst = await prisma.dialogTask.findUniqueOrThrow({
    where: { id: past.id },
    select: { status: true, failureReason: true },
  });
  const messagesAfterFirst = await prisma.message.count({
    where: { conversationId: conv.id, direction: "OUT" },
  });

  const second = await runDueDialogTasks(companyId);
  const messagesAfterSecond = await prisma.message.count({
    where: { conversationId: conv.id, direction: "OUT" },
  });
  const future = await prisma.dialogTask.findUniqueOrThrow({
    where: { id: PREFIX + "future" },
    select: { status: true },
  });

  /**
   * В песочнице WhatsApp выключен, поэтому отправка честно не удаётся — и это
   * ровно тот случай, который важнее проверить: неудача обязана быть записана
   * словами, а не потеряна.
   */
  const checks: [string, boolean, string][] = [
    ["назревшая задача разобрана", first.sent + first.failed === 1, JSON.stringify(first)],
    [
      "исход записан: либо ушло, либо названа причина",
      afterFirst.status === "DONE" || (afterFirst.status === "FAILED" && !!afterFirst.failureReason),
      `${afterFirst.status} ${afterFirst.failureReason ?? ""}`,
    ],
    ["второй круг не отправил то же самое", second.sent === 0, JSON.stringify(second)],
    [
      "второго сообщения пациенту не появилось",
      messagesAfterSecond === messagesAfterFirst,
      `${messagesAfterFirst} → ${messagesAfterSecond}`,
    ],
    ["задача с будущим временем не тронута", future.status === "PENDING", future.status],
  ];

  let bad = 0;
  for (const [what, ok, got] of checks) {
    console.log(`${ok ? "  ок  " : "ПЛОХО"}  ${what}${ok ? "" : `  — получили: ${got}`}`);
    if (!ok) bad += 1;
  }

  await prisma.dialogTask.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.message.deleteMany({ where: { conversationId: conv.id } });
  await prisma.conversation.delete({ where: { id: conv.id } });

  console.log(bad === 0 ? "\nвсё сошлось" : `\nнесошедшихся проверок: ${bad}`);
  if (bad > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
