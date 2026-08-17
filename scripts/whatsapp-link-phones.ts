/**
 * Достать номера у существующих диалогов и привязать карточки.
 *
 * WhatsApp перешёл на скрытые идентификаторы («…@lid»), и номер из адреса чата
 * пропал. На боевой базе это оставило почти всю переписку без карточек: люди
 * годами ходят в клинику, их визиты в базе есть, а диалог с ними числится за
 * незнакомцем — и агент разговаривает соответственно.
 *
 * Скрипт спрашивает номер у провайдера для каждого такого диалога, запоминает
 * его и привязывает диалог к карточке с тем же номером. Новых карточек не
 * создаёт: заводить их пачкой — отдельное решение, и принимать его должен
 * человек, глядя на результат.
 *
 *   npx tsx scripts/whatsapp-link-phones.ts           # показать план
 *   npx tsx scripts/whatsapp-link-phones.ts --apply   # выполнить
 *   npx tsx scripts/whatsapp-link-phones.ts --apply --limit=50
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { fetchContactPhone } from "../lib/integrations/whatsapp/green-api";
import { phoneFromChatId } from "../lib/integrations/whatsapp/chat-id";

/** «+79280004477» → «…4477»: опознать хватает, утечки нет. */
const tail = (phone: string) => `…${phone.slice(-4)}`;

function limitArg(): number {
  const raw = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 500;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const limit = limitArg();
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const convs = await prisma.conversation.findMany({
    where: { companyId: company.id, channel: "WHATSAPP", phoneE164: null },
    orderBy: { lastMessageAt: "desc" },
    take: limit,
    select: { id: true, externalUserId: true, patientId: true, contactName: true },
  });

  console.log(`клиника: ${company.name}`);
  console.log(`диалогов без номера: ${convs.length}`);
  if (!apply) {
    console.log("\nэто предварительный просмотр. чтобы выполнить: --apply");
    await prisma.$disconnect();
    return;
  }

  let resolved = 0;
  let linked = 0;
  let noPatient = 0;
  let failed = 0;

  for (const conv of convs) {
    // Старые чаты ещё содержат номер в адресе — лишний запрос к провайдеру не
    // нужен, а запросы у него не бесплатны и ограничены по частоте.
    const phone = phoneFromChatId(conv.externalUserId) ?? (await fetchContactPhone(company.id, conv.externalUserId).catch(() => null));

    if (!phone) {
      failed += 1;
      continue;
    }
    resolved += 1;

    await prisma.conversation.update({ where: { id: conv.id }, data: { phoneE164: phone } });

    if (conv.patientId) continue;

    const known = await prisma.patientPhone.findFirst({
      where: { companyId: company.id, phone, patient: { deletedAt: null } },
      select: { patientId: true },
    });
    if (!known) {
      noPatient += 1;
      console.log(`  ${tail(phone)} — карточки с таким номером нет${conv.contactName ? `, контакт «${conv.contactName}»` : ""}`);
      continue;
    }

    await prisma.conversation.update({ where: { id: conv.id }, data: { patientId: known.patientId } });
    linked += 1;
  }

  console.log(
    `\nномеров получено: ${resolved}, привязано карточек: ${linked}, ` +
      `без карточки: ${noPatient}, не удалось узнать номер: ${failed}`,
  );
  if (noPatient > 0) {
    console.log(
      "Диалоги без карточки — это обращения людей, которых нет в базе YCLIENTS. " +
        "Карточки им заведёт агент при записи или администратор вручную.",
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("не удалось:", e);
  await prisma.$disconnect();
  process.exit(1);
});
