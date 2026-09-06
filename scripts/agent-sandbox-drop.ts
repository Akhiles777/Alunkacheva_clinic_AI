/**
 * Убрать песочницу из базы.
 *
 * Нужен потому, что защита в scripts/agent-sandbox-seed.ts была написана
 * неверно: она проверяла, что база на localhost. На сервере боевой Postgres
 * тоже localhost — и песочница развернулась прямо в рабочей базе клиники.
 * Своих данных она не портит (у неё отдельная компания), но лишняя клиника с
 * выдуманными пациентами попадает в круг выгрузки и мешает.
 *
 * Удаляем по порядку: сначала то, что ссылается, потом то, на что ссылаются.
 * Полагаться на каскад нельзя — у состава визита ссылка на услугу стоит с
 * onDelete: Restrict, и удаление компании упёрлось бы в неё.
 *
 *   npx tsx scripts/agent-sandbox-drop.ts          # показать, что будет удалено
 *   npx tsx scripts/agent-sandbox-drop.ts --apply  # удалить
 */
import "dotenv/config";
import { prisma } from "../lib/db";

import { SANDBOX_YCLIENTS_IDS } from "./sandbox-id";

async function main() {
  const apply = process.argv.includes("--apply");

  const companies = await prisma.company.findMany({
    where: { yclientsId: { in: SANDBOX_YCLIENTS_IDS } },
    select: { id: true, name: true, yclientsId: true },
  });

  if (companies.length === 0) {
    console.log("песочницы в этой базе нет — удалять нечего");
    return;
  }

  for (const c of companies) {
    const [patients, appointments, conversations, services, knowledge] = await Promise.all([
      prisma.patient.count({ where: { companyId: c.id } }),
      prisma.appointment.count({ where: { companyId: c.id } }),
      prisma.conversation.count({ where: { companyId: c.id } }),
      prisma.service.count({ where: { companyId: c.id } }),
      prisma.knowledgeEntry.count({ where: { companyId: c.id } }),
    ]);
    console.log(`\n${c.name} (yclientsId ${c.yclientsId}, ${c.id})`);
    console.log(`  пациентов ${patients}, визитов ${appointments}, диалогов ${conversations}`);
    console.log(`  услуг ${services}, записей справочника ${knowledge}`);

    if (!apply) continue;

    const id = c.id;
    await prisma.appointmentService.deleteMany({ where: { companyId: id } });
    await prisma.appointment.deleteMany({ where: { companyId: id } });
    await prisma.course.deleteMany({ where: { companyId: id } });
    await prisma.coursePurchase.deleteMany({ where: { companyId: id } });
    await prisma.message.deleteMany({ where: { companyId: id } });
    await prisma.escalation.deleteMany({ where: { companyId: id } });
    await prisma.agentRun.deleteMany({ where: { companyId: id } });
    await prisma.conversation.deleteMany({ where: { companyId: id } });
    await prisma.patientConsent.deleteMany({ where: { companyId: id } });
    await prisma.patientPhone.deleteMany({ where: { companyId: id } });
    await prisma.patient.deleteMany({ where: { companyId: id } });
    await prisma.knowledgeEntry.deleteMany({ where: { companyId: id } });
    await prisma.service.deleteMany({ where: { companyId: id } });
    await prisma.staff.deleteMany({ where: { companyId: id } });
    await prisma.source.deleteMany({ where: { companyId: id } });
    await prisma.consentDocument.deleteMany({ where: { companyId: id } });
    await prisma.setting.deleteMany({ where: { companyId: id } });
    await prisma.company.delete({ where: { id } });
    console.log("  удалена");
  }

  if (!apply) {
    console.log("\nэто сухой прогон. Удалить: npx tsx scripts/agent-sandbox-drop.ts --apply");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
