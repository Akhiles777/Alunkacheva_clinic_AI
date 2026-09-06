/**
 * Расчистить диалоги, запертые запросом согласия.
 *
 * Запрос согласия ставил отметку «спросили», а без ответа «да» каждое
 * следующее сообщение упиралось в одну и ту же стену — и так неделями.
 * Пациентка ходит в клинику с июля, писала благодарность врачу, спрашивала
 * про свободное окно — и трижды получила «нужно ваше согласие».
 *
 * Правило исправлено, но уже проставленные отметки надо снять. Согласие
 * считается полученным там, где клиника человека ЗНАЕТ: есть визиты или
 * переписка старше суток. Придумывать согласие там, где отношений нет, мы не
 * будем — такие диалоги скрипт не трогает и называет отдельно.
 *
 * Переписку, статусы и паузы не меняет: агент от этого не начнёт отвечать на
 * старые сообщения.
 *
 *   npx tsx scripts/consent-unlock.ts           # посмотреть
 *   npx tsx scripts/consent-unlock.ts --apply
 */
import "dotenv/config";
import { prisma } from "../lib/db";

const DAY_MS = 24 * 3600 * 1000;

async function main() {
  const apply = process.argv.includes("--apply");
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const stuck = await prisma.conversation.findMany({
    where: {
      companyId: company.id,
      deletedAt: null,
      consentAskedAt: { not: null },
      consentGrantedAt: null,
    },
    select: {
      id: true,
      channel: true,
      contactName: true,
      consentAskedAt: true,
      patientId: true,
      patient: { select: { name: true } },
    },
    orderBy: { lastMessageAt: "desc" },
  });

  console.log(`клиника: ${company.name}`);
  console.log(`диалогов ждут согласия: ${stuck.length}\n`);
  if (stuck.length === 0) return;

  const known: typeof stuck = [];
  const strangers: typeof stuck = [];

  for (const c of stuck) {
    /** Визиты в карточке — согласие подписано на приёме, на бумаге. */
    const visits = c.patientId
      ? await prisma.appointment.count({
          where: { companyId: company.id, patientId: c.patientId, deletedAt: null },
        })
      : 0;
    /** Переписка старше суток — отношения начаты обеими сторонами. */
    const earlier = await prisma.message.count({
      where: {
        conversationId: c.id,
        deletedAt: null,
        isDraft: false,
        createdAt: { lt: new Date((c.consentAskedAt as Date).getTime() - DAY_MS) },
      },
    });
    (visits > 0 || earlier > 0 ? known : strangers).push(c);
  }

  const label = (c: (typeof stuck)[number]) =>
    `${c.id} · ${c.channel} · ${c.patient?.name ?? c.contactName ?? "без имени"}` +
    ` · спросили ${c.consentAskedAt?.toISOString().slice(0, 10)}`;

  console.log(`── КЛИНИКА ИХ ЗНАЕТ (визиты или переписка): ${known.length}`);
  for (const c of known.slice(0, 25)) console.log(`  ${label(c)}`);
  if (known.length > 25) console.log(`  … и ещё ${known.length - 25}`);

  if (strangers.length > 0) {
    console.log(`\n── НЕЗНАКОМЫЕ — НЕ ТРОГАЕМ: ${strangers.length}`);
    console.log("  Согласия у них действительно нет, и придумывать его нельзя (§7).");
    for (const c of strangers.slice(0, 10)) console.log(`  ${label(c)}`);
  }

  if (!apply) {
    console.log("\nсухой прогон: ничего не изменено");
    console.log("выполнить: npx tsx scripts/consent-unlock.ts --apply");
    return;
  }
  if (known.length === 0) {
    console.log("\nЗнакомых среди запертых нет — менять нечего.");
    return;
  }

  const now = new Date();
  const res = await prisma.conversation.updateMany({
    where: { id: { in: known.map((c) => c.id) }, companyId: company.id },
    data: { consentGrantedAt: now },
  });
  console.log(`\nразблокировано диалогов: ${res.count}`);
  console.log("Переписка, статусы и паузы не изменились — агент не начнёт отвечать на старые");
  console.log("сообщения: границы возврата и добора остались прежними.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
