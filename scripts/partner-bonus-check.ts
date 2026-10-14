import { prisma } from "../lib/db";
import { recomputePartnerBonuses } from "../lib/server/promos";
import type { BonusAction } from "../lib/metrics/partner-bonus";

/**
 * Бонусы школам-партнёрам: что есть и что изменит пересчёт.
 *
 * По умолчанию — сухой прогон: печатает акции, школы, привязки и действия
 * пересчёта (начислить / снять с причиной), ничего не записывая. `--apply`
 * выполняет тот же пересчёт, что идёт после каждой выгрузки YCLIENTS.
 * Имён и телефонов не печатает — только идентификаторы и числа.
 *
 *   npx tsx --env-file=.env scripts/partner-bonus-check.ts [--apply]
 */

const APPLY = process.argv.includes("--apply");

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  for (const c of companies) {
    const promos = await prisma.promo.findMany({
      where: { companyId: c.id },
      select: { id: true, name: true, serviceIds: true, endsAt: true, isActive: true, agentEnabled: true },
    });
    if (!promos.length) continue;
    console.log(`\n${c.name}`);
    for (const p of promos) {
      const [schools, attributions, bonuses] = await Promise.all([
        prisma.partnerSchool.count({ where: { promoId: p.id } }),
        prisma.partnerAttribution.groupBy({ by: ["source"], where: { promoId: p.id, removedAt: null }, _count: true }),
        prisma.partnerBonus.groupBy({ by: ["status"], where: { attribution: { promoId: p.id } }, _count: true, _sum: { amount: true } }),
      ]);
      console.log(
        `  «${p.name}» до ${p.endsAt.toISOString().slice(0, 10)}${p.isActive ? "" : " (выключена)"}, агент ${p.agentEnabled ? "знает" : "не знает"}`,
      );
      console.log(`    услуг YCLIENTS: ${p.serviceIds.length || "НЕ ВЫБРАНЫ — бонус не начислится никому"}, школ: ${schools}`);
      console.log(`    привязок: ${attributions.map((a) => `${a.source === "AGENT" ? "агент" : "администратор"} ${a._count}`).join(", ") || "0"}`);
      console.log(`    бонусы: ${bonuses.map((b) => `${b.status} ${b._count} на ${Number(b._sum.amount ?? 0)} ₽`).join(", ") || "0"}`);
    }
    const plan: BonusAction[] = [];
    const r = await recomputePartnerBonuses(c.id, new Date(), { dryRun: !APPLY, plan });
    console.log(`  ${APPLY ? "Сделано" : "Пересчёт сделал бы"}: начислить ${r.earned}, снять ${r.reversed}`);
    for (const a of plan) {
      console.log(
        a.kind === "earn"
          ? `    + привязка ${a.attributionId}: визит ${a.appointmentId}, ${a.amount} ₽`
          : `    − бонус ${a.bonusId}: ${a.reason}`,
      );
    }
  }
  if (!APPLY) console.log("\nСухой прогон. С --apply пересчёт будет записан.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
