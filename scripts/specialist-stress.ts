/**
 * Самое опасное место пересылки: ответ врача, ушедший НЕ ТОМУ пациенту.
 *
 * Без цитаты ответ относится к единственному открытому вопросу — и это
 * единственная развилка, где можно ошибиться адресатом. Проверяем оба случая:
 * два открытых вопроса без цитаты (агент обязан переспросить, а не гадать) и
 * ответ с цитатой (обязан уйти ровно тому, чей вопрос).
 *
 * Идёт только по песочнице: скрипт заводит диалоги и вопросы.
 *
 *   npx tsx scripts/specialist-stress.ts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/db";
import { handleSpecialistReply } from "../lib/agent/specialist";
import { SANDBOX_YCLIENTS_ID } from "./sandbox-id";

process.env.AGENT_DRILL = "1";
async function main() {
  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: SANDBOX_YCLIENTS_ID },
  });
  const specialist = await prisma.clinicSpecialist.findFirstOrThrow({
    where: { companyId: company.id },
  });

  const convs = [];
  for (const who of ["Пациент А", "Пациент Б"]) {
    const c = await prisma.conversation.create({
      data: {
        companyId: company.id,
        channel: "WHATSAPP",
        externalUserId: `stress-${randomUUID()}`,
        contactName: who,
        status: "BOT_ACTIVE",
        startedAt: new Date(),
        lastMessageAt: new Date(),
      },
    });
    convs.push(c);
  }

  let ref = 9000;
  for (const c of convs) {
    await prisma.specialistQuery.create({
      data: {
        companyId: company.id,
        conversationId: c.id,
        specialistId: specialist.id,
        kind: "MEDICAL",
        ref: ref++,
        question: `вопрос от ${c.contactName}`,
      },
    });
  }

  console.log("открытых вопросов: 2, от разных пациентов\n");

  const noQuote = await handleSpecialistReply({
    companyId: company.id,
    specialist,
    raw: "Да, можно",
  });
  console.log("ответ БЕЗ цитаты →", JSON.stringify(noQuote));

  const withQuote = await handleSpecialistReply({
    companyId: company.id,
    specialist,
    raw: "В ответ на: «Вопрос от пациента — Пациент Б (WhatsApp) · #9001»\nДа, можно",
  });
  console.log("ответ С цитатой  →", JSON.stringify(withQuote));

  const relayed = await prisma.message.findMany({
    where: { companyId: company.id, conversationId: { in: convs.map((c) => c.id) }, direction: "OUT" },
    select: { conversationId: true, body: true },
  });
  console.log("\nчто ушло пациентам:");
  for (const m of relayed) {
    const c = convs.find((x) => x.id === m.conversationId);
    console.log(`  ${c?.contactName}: ${m.body}`);
  }
  if (relayed.length === 0) console.log("  ничего");

  await prisma.specialistQuery.deleteMany({ where: { companyId: company.id, ref: { gte: 9000 } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: convs.map((c) => c.id) } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convs.map((c) => c.id) } } });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
