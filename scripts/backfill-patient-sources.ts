/**
 * Проставить источник ПЕРВОГО обращения — карточкам пациентов и диалогам.
 *
 * В карточке стояло «Первое обращение: 6 сентября, источник: —» — при том что
 * визиты того же человека подписаны «WhatsApp · из переписки». Автоатрибуция
 * дошла до визитов и не дошла до самого пациента; здесь это достраивается на
 * уже накопленной истории. Дальше то же делает каждый полный круг выгрузки.
 *
 *   npx tsx scripts/backfill-patient-sources.ts           # только показать
 *   npx tsx scripts/backfill-patient-sources.ts --apply
 *
 * По умолчанию — сухой прогон: печатает «было → станет» и не пишет ничего.
 * Уже проставленный источник не трогается ни в каком режиме: ни ручной, ни
 * выведенный раньше.
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { recomputePatientSources } from "../lib/metrics/recompute";

async function distribution(companyId: string) {
  const rows = await prisma.patient.groupBy({
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

function print(label: string, rows: { title: string; confidence: string; count: number }[]) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  console.log(`\n${label} (карточек ${total}):`);
  if (rows.length === 0) {
    console.log("  карточек нет");
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

  print("БЫЛО", await distribution(company.id));

  /**
   * Сухой прогон считает тем же кодом, что и боевой, но с `apply: false`:
   * «что будет» показывается настоящим ответом, а не отдельной прикидкой,
   * которая разойдётся с боевой через месяц.
   */
  const plan = await recomputePatientSources(company.id, { apply: false });
  console.log(`\nСТАНЕТ:`);
  console.log(`  диалогов получат источник по каналу: ${plan.dialogsFilled}`);
  console.log(`  карточек рассмотрено (источник пуст): ${plan.scanned}`);
  console.log(`  карточек получат источник:           ${plan.derived}`);
  console.log(`  останутся без источника:             ${plan.unknown}`);
  console.log(`  карточек не тронем (источник есть):   ${plan.kept}`);

  const sample = plan.plan.slice(0, 15);
  if (sample.length > 0) {
    console.log(`\nпримеры (первые ${sample.length}):`);
    for (const row of sample) {
      console.log(`  ${row.patientId}  — → ${row.to}  (основание: ${row.basis})`);
    }
  }

  if (!apply) {
    console.log(`\nсухой прогон: ничего не записано`);
    console.log(`запустить по-настоящему: npx tsx scripts/backfill-patient-sources.ts --apply`);
    return;
  }

  const result = await recomputePatientSources(company.id);
  console.log(`\nзаписано: карточек ${result.derived}, диалогов ${result.dialogsFilled}`);
  print("СТАЛО", await distribution(company.id));

  /**
   * Второй прогон подряд обязан не менять ничего. Поменял — пересчёт не
   * идемпотентен, и каждая выгрузка переписывала бы историю заново.
   */
  const again = await recomputePatientSources(company.id);
  const stable = again.derived === 0 && again.dialogsFilled === 0;
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
