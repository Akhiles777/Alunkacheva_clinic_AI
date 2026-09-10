/**
 * Контроль качества ответов агента: что проверка возьмёт и что она нашла.
 *
 * По умолчанию НИЧЕГО не проверяет и модель не трогает — только показывает
 * выборку и уже вынесенные вердикты. Проверка стоит денег, и запускать её
 * случайным «посмотреть, что там» нельзя.
 *
 *   npx tsx scripts/agent-quality.ts            # что возьмут ночью + итоги
 *   npx tsx scripts/agent-quality.ts --full     # с текстами вопроса и ответа
 *   npx tsx scripts/agent-quality.ts --run      # проверить порцию сейчас (платно)
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { previewSample, runQualityCheck, qualitySummary } from "../lib/server/agent-quality";
import { VERDICT_LABEL, SAMPLE_LIMIT, type Verdict } from "../lib/metrics/quality-sample";

const REASON: Record<string, string> = {
  medical: "медицинская тема",
  escalated: "после ответа позвали человека",
  reasked: "пациент переспросил",
  ungrounded: "без записи справочника",
  random: "случайно",
};

const when = (at: Date) => at.toISOString().slice(0, 16).replace("T", " ");
const short = (text: string, n = 110) =>
  text.replace(/\s+/g, " ").trim().slice(0, n) + (text.length > n ? "…" : "");

async function main() {
  const full = process.argv.includes("--full");
  const run = process.argv.includes("--run");
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  console.log(`клиника: ${company.name}\n`);

  // ── что уже проверено
  const summary = await qualitySummary(company.id);
  console.log("── ЧТО УЖЕ ПРОВЕРЕНО");
  if (summary.checked === 0) {
    console.log("  ни одной проверки. Это не «всё хорошо» — это «не проверяли».\n");
  } else {
    console.log(`  проверок: ${summary.checked} (с ${summary.since?.slice(0, 10)})`);
    console.log(`  замечаний: ${summary.problems}`);
    console.log(
      `  человек подтвердил: ${summary.confirmed}, отклонил: ${summary.rejected}` +
        `  ← отклонённые это ошибки самой проверки\n`,
    );

    const rows = await prisma.agentQualityCheck.groupBy({
      by: ["verdict"],
      where: { companyId: company.id },
      _count: { _all: true },
    });
    for (const r of rows.sort((a, b) => b._count._all - a._count._all)) {
      const label = VERDICT_LABEL[r.verdict as Verdict] ?? r.verdict;
      console.log(`  ${String(r._count._all).padStart(4)}  ${r.verdict} — ${label}`);
    }
    console.log("");
  }

  // ── что возьмут в проверку
  const preview = await previewSample(company.id);
  console.log("── ЧТО ВОЗЬМУТ В ПРОВЕРКУ");
  if (preview.skipped) {
    console.log(`  ${preview.skipped}`);
    console.log(`  за неделю уже проверено ${preview.spent} из ${SAMPLE_LIMIT}\n`);
  } else {
    console.log(
      `  в выборке ${preview.items.length}; за неделю проверено ${preview.spent} из ${SAMPLE_LIMIT}, ` +
        `сегодня возьмут не больше ${preview.budget}\n`,
    );
    for (const item of preview.items) {
      console.log(`  ${when(item.at)}  ${REASON[item.reason] ?? item.reason}`);
      if (full) {
        console.log(`      спросили: ${short(item.question) || "(вопрос не сохранился)"}`);
        console.log(`      ответил:  ${short(item.answer)}`);
        console.log(`      справка:  ${item.source ? short(item.source) : "НЕТ — ответ без опоры"}`);
      }
    }
    console.log("");
  }

  if (!run) {
    console.log("Проверка не запускалась. Запустить порцию: --run (обращения к модели платные).");
    return;
  }

  console.log("── ПРОВЕРКА");
  const result = await runQualityCheck(company.id);
  console.log(`  в выборке: ${result.sampled}`);
  console.log(`  проверено сейчас: ${result.checked}`);
  console.log(`  требуют человека: ${result.problems}`);
  if (result.skipped) console.log(`  остановились: ${result.skipped}`);
  console.log("\nРазбор — «Настройки → Ассистент → Контроль качества ответов».");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
