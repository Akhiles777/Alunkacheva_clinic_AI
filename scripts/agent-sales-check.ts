/**
 * Что ассистент довёл до записи — разбор на живых данных.
 *
 * Показывает не только итог, но и каждую засчитанную заявку: число без
 * возможности проверить, из чего оно сложилось, доверия не заслуживает.
 *
 *   npx tsx scripts/agent-sales-check.ts        # за 30 дней
 *   npx tsx scripts/agent-sales-check.ts 90
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { getAgentSales } from "../lib/server/agent-sales";

async function main() {
  const days = Number(process.argv[2] ?? 30);
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 3600 * 1000);

  const report = await getAgentSales(company.id, from, to);
  console.log(`клиника: ${company.name}, период: ${days} дней\n`);
  console.log(`заявок собрал ассистент: ${report.bookings}`);
  console.log(`из них состоялось:       ${report.arrived}`);
  console.log(`деньги состоявшихся:     ${report.revenue.toLocaleString("ru-RU")} ₽\n`);

  if (report.byService.length > 0) {
    console.log("по услугам:");
    for (const r of report.byService) {
      console.log(`  ${r.title}: заявок ${r.bookings}, пришли ${r.arrived}, ${r.revenue} ₽`);
    }
  }
  if (report.sales.length > 0) {
    console.log("\nзаявки:");
    for (const s of report.sales.slice(0, 20)) {
      console.log(
        `  ${s.at.toISOString().slice(0, 10)} ${s.patientName ?? "без имени"} — ` +
          `${s.services.join(", ")} — ${s.arrived ? `${s.revenue} ₽` : "ещё не прошёл"}`,
      );
    }
  }
  if (report.bookings === 0) {
    console.log("\nНи одной заявки. Считается только та, где данные собрал сам ассистент:");
    console.log("если разговор с начала вёл администратор, запись в счёт не идёт.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
