/**
 * Проставить источник визитам по переписке.
 *
 * В YCLIENTS источник обращения не заполняет никто: на боевых данных он не
 * проставлен ни у одного визита, и разрез воронки по источникам показывает
 * одну строку «источник не указан». Переписка есть только у нас, и по ней
 * видно, откуда человек пришёл.
 *
 * Дальше это делает сама выгрузка каждым кругом. Скрипт нужен один раз — на
 * уже загруженную историю — и потом для разбора: что вышло и почему.
 *
 *   npx tsx scripts/backfill-sources.ts             # только показать
 *   npx tsx scripts/backfill-sources.ts --apply
 *
 * Ручной источник не трогается ни в каком режиме. Никогда.
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { recomputeAppointmentSources } from "../lib/metrics/recompute";

interface Row {
  title: string;
  confidence: string;
  count: number;
}

/** Как визиты разложены по источникам прямо сейчас. */
async function distribution(companyId: string): Promise<Row[]> {
  const rows = await prisma.appointment.groupBy({
    by: ["sourceId", "sourceConfidence"],
    where: { companyId, deletedAt: null },
    _count: { _all: true },
  });
  const sources = await prisma.source.findMany({
    where: { companyId },
    select: { id: true, title: true },
  });
  const title = new Map(sources.map((s) => [s.id, s.title]));

  return rows
    .map((r) => ({
      title: r.sourceId ? (title.get(r.sourceId) ?? "источник удалён") : "неизвестен",
      confidence: r.sourceConfidence,
      count: r._count._all,
    }))
    .sort((a, b) => b.count - a.count);
}

function print(label: string, rows: Row[]) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  console.log(`\n${label} (визитов ${total}):`);
  if (rows.length === 0) {
    console.log("  визитов нет");
    return;
  }
  for (const r of rows) {
    const share = total === 0 ? 0 : Math.round((r.count / total) * 100);
    console.log(
      `  ${r.title.padEnd(22)} ${String(r.count).padStart(5)}  ${String(share).padStart(3)}%  ${r.confidence.toLowerCase()}`,
    );
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  console.log(`клиника: ${company.name}`);

  const before = await distribution(company.id);
  print("БЫЛО", before);

  if (!apply) {
    /**
     * Сухой прогон считает по тем же данным тем же кодом, но ничего не пишет:
     * пересчёт идемпотентен, и «что будет» показывается настоящим ответом, а
     * не отдельной прикидкой, которая разойдётся с боевой через месяц.
     */
    const conversations = await prisma.conversation.count({
      where: { companyId: company.id, deletedAt: null, patientId: { not: null } },
    });
    const manual = before.filter((r) => r.confidence === "MANUAL").reduce((s, r) => s + r.count, 0);
    console.log(`\nсухой прогон: ничего не записано`);
    console.log(`  диалогов, привязанных к пациенту: ${conversations}`);
    console.log(`  визитов с ручным источником (не тронем): ${manual}`);
    console.log(`\nзапустить по-настоящему: npx tsx scripts/backfill-sources.ts --apply`);
    return;
  }

  const result = await recomputeAppointmentSources(company.id);
  console.log(`\nпересчёт:`);
  console.log(`  рассмотрено визитов:      ${result.scanned}`);
  console.log(`  источник выведен:         ${result.derived}`);
  console.log(`  осталось неизвестных:     ${result.unknown}`);
  console.log(`  снято прежних выводов:    ${result.cleared}`);
  console.log(`  ручных не тронуто:        ${result.manualKept}`);

  print("СТАЛО", await distribution(company.id));

  /**
   * Второй прогон подряд обязан не менять ничего. Если поменял — пересчёт не
   * идемпотентен, и каждая выгрузка переписывает историю заново.
   */
  const again = await recomputeAppointmentSources(company.id);
  const stable = again.derived === result.derived && again.cleared === 0;
  console.log(
    `\nповторный прогон: ${stable ? "ничего не изменил — пересчёт устойчив" : "ИЗМЕНИЛ данные, пересчёт неустойчив"}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
