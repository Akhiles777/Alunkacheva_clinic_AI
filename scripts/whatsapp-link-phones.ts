/**
 * Достать номера у существующих диалогов и привязать карточки.
 *
 * WhatsApp перешёл на скрытые идентификаторы («…@lid»), и номер из адреса чата
 * пропал. На боевой базе это оставило почти всю переписку без карточек: люди
 * годами ходят в клинику, их визиты в базе есть, а диалог с ними числится за
 * незнакомцем — и агент разговаривает соответственно.
 *
 * Скрипт спрашивает номер у провайдера для каждого такого диалога, запоминает
 * его и привязывает диалог к карточке с тем же номером.
 *
 * С флагом --create заводит карточки тем, кого в базе нет. Отдельным флагом
 * намеренно: среди собеседников клиники есть не только пациенты — магазины,
 * сотрудники, знакомые. Каждая такая карточка попадёт в «новых пациентов» и
 * испортит метрики, поэтому решение принимает человек, увидев список.
 *
 *   npx tsx scripts/whatsapp-link-phones.ts                    # показать план
 *   npx tsx scripts/whatsapp-link-phones.ts --apply            # привязать существующие
 *   npx tsx scripts/whatsapp-link-phones.ts --apply --create   # и завести недостающие
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
  const create = process.argv.includes("--create");
  const limit = limitArg();
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const convs = await prisma.conversation.findMany({
    where: {
      companyId: company.id,
      channel: "WHATSAPP",
      // Диалоги без номера и те, что номер получили, но карточки так и не
      // нашли: второй проход с --create должен их подхватить.
      OR: [{ phoneE164: null }, { patientId: null }],
    },
    orderBy: { lastMessageAt: "desc" },
    take: limit,
    select: {
      id: true,
      externalUserId: true,
      patientId: true,
      contactName: true,
      phoneE164: true,
      sourceId: true,
      startedAt: true,
    },
  });

  console.log(`клиника: ${company.name}`);
  console.log(`диалогов без номера или без карточки: ${convs.length}`);
  if (!create) console.log("карточки заводиться не будут — для этого нужен флаг --create");
  if (!apply) {
    console.log("\nэто предварительный просмотр. чтобы выполнить: --apply");
    await prisma.$disconnect();
    return;
  }

  let resolved = 0;
  let linked = 0;
  let noPatient = 0;
  let created = 0;
  let failed = 0;

  for (const conv of convs) {
    // Старые чаты ещё содержат номер в адресе — лишний запрос к провайдеру не
    // нужен, а запросы у него не бесплатны и ограничены по частоте.
    const phone =
      conv.phoneE164 ??
      phoneFromChatId(conv.externalUserId) ??
      (await fetchContactPhone(company.id, conv.externalUserId).catch(() => null));

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
      if (!create) {
        noPatient += 1;
        console.log(`  ${tail(phone)} — карточки с таким номером нет${conv.contactName ? `, контакт «${conv.contactName}»` : ""}`);
        continue;
      }

      /**
       * Заводим карточку.
       *
       * Дата первого обращения — начало переписки, а не «сейчас»: иначе полторы
       * тысячи человек с многолетней историей разом становятся первичными, и
       * отчёты врут ровно так, как это уже было после первой выгрузки.
       */
      const source = await prisma.source.findFirst({
        where: { companyId: company.id, code: "whatsapp" },
        select: { id: true },
      });
      const patient = await prisma.patient.create({
        data: {
          companyId: company.id,
          name: conv.contactName?.trim() || null,
          firstSeenAt: conv.startedAt,
          sourceId: conv.sourceId ?? source?.id ?? null,
          phones: {
            create: { companyId: company.id, phone, isPrimary: true, usedForWhatsapp: true },
          },
        },
        select: { id: true },
      });
      await prisma.conversation.update({ where: { id: conv.id }, data: { patientId: patient.id } });
      created += 1;
      console.log(`  заведена карточка ${tail(phone)}${conv.contactName ? ` — ${conv.contactName}` : ""}`);
      continue;
    }

    await prisma.conversation.update({ where: { id: conv.id }, data: { patientId: known.patientId } });
    linked += 1;
  }

  console.log(
    `\nномеров получено: ${resolved}, привязано карточек: ${linked}, ` +
      `заведено карточек: ${created}, без карточки: ${noPatient}, ` +
      `не удалось узнать номер: ${failed}`,
  );
  if (noPatient > 0) {
    console.log("Чтобы завести недостающие карточки, добавьте --create.");
  }
  if (created > 0) {
    console.log(
      "Проверьте список заведённых: среди собеседников клиники бывают магазины, " +
        "сотрудники и знакомые. Лишнюю карточку можно удалить в разделе «Пациенты» — " +
        "диалог при этом отвяжется, а номер освободится.",
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("не удалось:", e);
  await prisma.$disconnect();
  process.exit(1);
});
