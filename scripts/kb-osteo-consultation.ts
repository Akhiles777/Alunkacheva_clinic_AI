import { prisma } from "../lib/db";

/**
 * Запись справочника «Консультация у остеопата» — со слов администратора
 * клиники (живой диалог 15 октября).
 *
 * Пациентка спросила «сколько стоит ваша консультация? Детей принимаете?», и
 * агент ответил «Консультация в клинике стоит 1000 ₽» — взял общую строку
 * прайса «Консультация». Администратор поправила: «Консультации остеопатов в
 * клинике нет. Доктора проводят осмотр и сразу же начинают работать с
 * ребёнком. Детей принимаем». Записи об этом в справочнике не было — агенту
 * опереться было не на что.
 *
 * Цен в тексте нет намеренно: их агент берёт из прайса и называет кодом —
 * цифра в справке устарела бы при первой правке прайса. Запись не
 * медицинская (о порядке приёма, а не о показаниях), поэтому утверждения
 * врачом не требует.
 *
 * По умолчанию только показывает, что сделает. `--apply` — добавляет; запись с
 * той же темой уже есть — не трогает.
 *
 *   npx tsx --env-file=.env scripts/kb-osteo-consultation.ts [--apply]
 */

const APPLY = process.argv.includes("--apply");

const ENTRY = {
  topic: "Консультация у остеопата",
  question:
    "Сколько стоит консультация? Есть ли консультация у остеопата? Консультация для ребёнка. Сначала консультация, потом приём?",
  answer:
    "Отдельной консультации у остеопатов в клинике нет: доктор проводит осмотр и сразу же начинает работать — это и есть приём. " +
    "Стоимость — как у приёма остеопата.",
};

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  for (const c of companies) {
    const existing = await prisma.knowledgeEntry.findFirst({
      where: { companyId: c.id, promoId: null, topic: { equals: ENTRY.topic, mode: "insensitive" } },
      select: { id: true, isActive: true },
    });
    if (existing) {
      console.log(`${c.name}: запись «${ENTRY.topic}» уже есть (${existing.isActive ? "включена" : "выключена"}) — не трогаю.`);
      continue;
    }
    if (!APPLY) {
      console.log(`${c.name}: добавлю запись «${ENTRY.topic}»:\n  ${ENTRY.answer}`);
      continue;
    }
    await prisma.knowledgeEntry.create({
      data: { companyId: c.id, ...ENTRY, isActive: true, needsDoctorApproval: false },
    });
    console.log(`${c.name}: запись «${ENTRY.topic}» добавлена и включена.`);
  }
  if (!APPLY) console.log("\nСухой прогон. С --apply запись будет добавлена.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
