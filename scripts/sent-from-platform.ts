/**
 * Что ушло пациентам за день и откуда.
 *
 * Вопрос «а сегодня вообще что-нибудь отправляли с платформы?» звучит после
 * каждой выкатки, и до сих пор ответ на него искали глазами по переписке.
 * Здесь он собран одной командой, и главное в нём — РАЗНИЦА между тремя
 * источниками одного и того же исходящего сообщения:
 *
 *   · с платформы — сотрудник написал у нас (`viaPlatform`);
 *   · агент — ответил ассистент;
 *   · с телефона — сотрудник написал из WhatsApp на своём аппарате, и
 *     сообщение пришло к нам вебхуком.
 *
 * Третье и есть то, ради чего весь цикл затевался: пока эта доля не падает,
 * платформа чего-то не даёт (§ «Перешёл ли администратор в систему»).
 *
 * Только числа, время и статусы. Тел сообщений здесь нет (§7) — кроме
 * `--text`, который печатает первые слова и нужен при разборе конкретного
 * сбоя; по умолчанию он выключен.
 *
 *   npx tsx scripts/sent-from-platform.ts              # за сегодня
 *   npx tsx scripts/sent-from-platform.ts 2026-09-11   # за конкретный день
 *   npx tsx scripts/sent-from-platform.ts 2026-09-11 --text
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { clinicDayRange, clinicDateKey } from "../lib/clinic-time";

const hhmm = (at: Date) =>
  new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(at);

async function main() {
  const arg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const withText = process.argv.includes("--text");
  const day = arg ?? clinicDateKey(new Date());
  const { start: from, end: to } = clinicDayRange(new Date(`${day}T12:00:00Z`));

  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  console.log(`клиника: ${company.name}`);
  console.log(`день: ${day} (${from.toISOString()} — ${to.toISOString()})\n`);

  const out = await prisma.message.findMany({
    where: {
      companyId: company.id,
      direction: "OUT",
      deletedAt: null,
      isDraft: false,
      createdAt: { gte: from, lt: to },
      conversation: { isPractice: false },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      body: true,
      createdAt: true,
      status: true,
      failureReason: true,
      authorType: true,
      viaPlatform: true,
      channel: true,
      conversation: { select: { id: true, contactName: true, patient: { select: { name: true } } } },
    },
  });

  if (out.length === 0) {
    console.log("── ИСХОДЯЩИХ ЗА ЭТОТ ДЕНЬ НЕТ");
    console.log("  Ни с платформы, ни от агента, ни с телефона.");
    console.log("  Это не сбой сам по себе: в выходной или тихий день так и бывает.");
    return;
  }

  /**
   * Откуда ушло. `viaPlatform` ставит сама отправка, и это ФАКТ, а не вывод по
   * автору: у сессии без сотрудника автора нет, и по нему платформа была бы
   * неотличима от телефона.
   */
  const kind = (m: (typeof out)[number]): "платформа" | "агент" | "телефон" => {
    if (m.authorType === "BOT") return "агент";
    return m.viaPlatform ? "платформа" : "телефон";
  };

  const counts = { платформа: 0, агент: 0, телефон: 0 };
  for (const m of out) counts[kind(m)] += 1;

  console.log("── ОТКУДА УШЛО");
  console.log(`  с платформы: ${counts.платформа}`);
  console.log(`  от агента:   ${counts.агент}`);
  console.log(`  с телефона:  ${counts.телефон}  ← мимо платформы\n`);

  const failed = out.filter((m) => m.status === "FAILED");
  console.log("── ДОСТАВКА");
  console.log(`  всего исходящих: ${out.length}, из них не ушло: ${failed.length}`);
  if (failed.length > 0) {
    for (const m of failed) {
      console.log(`  ${hhmm(m.createdAt)} ${kind(m)} · ${m.failureReason ?? "причина не записана"}`);
    }
  }
  console.log("");

  console.log("── ПО ВРЕМЕНИ");
  for (const m of out) {
    const who = m.conversation.patient?.name?.trim() || m.conversation.contactName?.trim() || "без имени";
    const tail = withText ? ` · ${m.body.replace(/\s+/g, " ").slice(0, 60)}` : "";
    console.log(
      `  ${hhmm(m.createdAt)}  ${kind(m).padEnd(9)} ${m.status.padEnd(6)} ${m.channel.padEnd(8)} ${who}${tail}`,
    );
  }

  if (counts.платформа === 0) {
    console.log("\n── ВНИМАНИЕ");
    console.log("  С платформы сегодня не отправляли НИ РАЗУ.");
    console.log("  Сообщения пациентам при этом уходили — значит их писали с телефона");
    console.log("  или отвечал агент. Разбираться надо с платформой, а не с людьми.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
