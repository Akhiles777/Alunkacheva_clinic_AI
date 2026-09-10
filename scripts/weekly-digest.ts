/**
 * Еженедельная сводка: что она увидит и что в ней окажется.
 *
 * По умолчанию НИЧЕГО не сохраняет и модель не трогает — печатает ряды,
 * пороги и наблюдения. Это главный способ проверить порог значимости на
 * живых данных: увидеть, какие метрики он считает шумом, а какие событием.
 *
 *   npx tsx scripts/weekly-digest.ts          # что попадёт в сводку
 *   npx tsx scripts/weekly-digest.ts --rows   # с недельными рядами целиком
 *   npx tsx scripts/weekly-digest.ts --apply  # сформировать и сохранить (платно)
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { collectDigest, plainText, makeWeeklyDigest } from "../lib/server/weekly-digest";
import { weeklyBuckets } from "../lib/server/weekly-series";

const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;

async function main() {
  const rows = process.argv.includes("--rows");
  const apply = process.argv.includes("--apply");
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  console.log(`клиника: ${company.name}\n`);

  if (rows) {
    const buckets = await weeklyBuckets(company.id, 9);
    console.log("── НЕДЕЛЬНЫЕ РЯДЫ (последняя строка — разбираемая неделя)");
    for (const b of buckets) {
      const day = new Date(b.key).toISOString().slice(0, 10);
      console.log(
        `  ${day}  выручка ${money(b.revenue).padStart(12)}  приёмов ${String(b.appts).padStart(3)}` +
          `  новых ${String(b.newPatients).padStart(3)}  чеков ${String(b.paying).padStart(3)}`,
      );
    }
    console.log("");
  }

  const { label, digest, metrics } = await collectDigest(company.id);
  console.log(`── НЕДЕЛЯ ${label}`);
  console.log(`  база для сравнения: ${digest.hasBaseline ? "есть" : "НЕТ (нужно 8 полных недель)"}`);
  if (digest.note) console.log(`  ${digest.note}`);
  console.log("");

  console.log("── ЗНАЧЕНИЯ НЕДЕЛИ");
  for (const [key, value] of Object.entries(metrics)) {
    console.log(`  ${key.padEnd(14)} ${Math.round(value * 10) / 10}`);
  }
  console.log("");

  console.log("── НАБЛЮДЕНИЯ");
  if (digest.observations.length === 0) {
    console.log("  ничего за пределами обычного разброса\n");
  } else {
    for (const o of digest.observations) {
      console.log(`  ${o.title}: ${o.text}`);
      console.log(`      сила отклонения ${o.score.toFixed(1)} · ${o.worse ? "к худшему" : "к лучшему"} · ${o.href}`);
      if (o.hypothesis) console.log(`      ${o.hypothesis}`);
      if (o.note) console.log(`      ${o.note}`);
    }
    console.log("");
  }

  console.log("── ТЕКСТ БЕЗ МОДЕЛИ (он же эталон, с которым сверяется её текст)");
  console.log(
    plainText(label, digest)
      .split("\n")
      .map((l) => (l ? `  ${l}` : ""))
      .join("\n"),
  );
  console.log("");

  if (!apply) {
    console.log("Ничего не сохранено. Сформировать и записать: --apply (обращение к модели платное).");
    return;
  }

  const result = await makeWeeklyDigest(company.id);
  console.log("── СОХРАНЕНО");
  console.log(`  неделя ${result.weekKey}, наблюдений ${result.observations}`);
  if (!result.created) console.log(`  новой записи нет: ${result.skipped}`);
  console.log("\nЧитать — «Кабинет владельца → Сводка недели».");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
