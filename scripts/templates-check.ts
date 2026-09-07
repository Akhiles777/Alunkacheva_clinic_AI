/**
 * Проверка шаблонов на живых данных: перенос, подстановка, отказ без данных.
 *
 *   npx tsx scripts/templates-check.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { fillTemplate, missingLabel, templateVariables } from "../lib/message-template";
import { ensureTemplates } from "../lib/server/message-templates";

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const moved = await ensureTemplates(company.id);
  if (moved > 0) console.log(`перенесено из старой настройки: ${moved}`);

  const rows = await prisma.messageTemplate.findMany({
    where: { companyId: company.id },
    orderBy: { createdAt: "asc" },
  });

  console.log(`клиника: ${company.name}`);
  console.log(`шаблонов в таблице: ${rows.length}\n`);
  for (const t of rows) {
    const vars = templateVariables(t.bodyTemplate);
    console.log(`  ${t.status.padEnd(16)} ${t.code} — ${t.title}`);
    console.log(`    ${t.bodyTemplate}`);
    if (vars.length > 0) console.log(`    переменные: ${vars.join(", ")}`);

    const full = fillTemplate(t.bodyTemplate, {
      name: "Гульбара",
      date: "8 сентября",
      time: "09:00",
      service: "Детский приём",
      staff: "Ирина Алилгаджиевна",
      clinic: company.name,
    });
    console.log(`    пациент увидит: ${full.ok ? full.text : "— не заполнилось"}`);

    const empty = fillTemplate(t.bodyTemplate, { name: "Гульбара" });
    if (!empty.ok) console.log(`    без записи не отправится: не хватает ${missingLabel(empty.missing)}`);
    console.log();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
