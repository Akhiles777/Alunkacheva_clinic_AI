/**
 * Какая услуга у клиники «основная» — та, что агент предлагает на «есть
 * окошко?», «сколько стоит приём?», когда услуга не названа (§6).
 *
 * Считается по ЛЮДЯМ за год, а не по приёмам: курс БОС из тридцати сеансов —
 * один человек. Скрипт показывает обе меры рядом, чтобы было видно, почему
 * счёт по приёмам не годится.
 *
 *   npx tsx scripts/main-kind-check.ts
 *
 * Ничего не меняет и никому не пишет. Пациентов не печатает — только числа.
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { mainServiceKind, serviceKind } from "../lib/agent/clinic-agent";

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  const since = new Date(Date.now() - 365 * 86_400_000);
  for (const c of companies) {
    const rows = await prisma.appointment.findMany({
      where: { companyId: c.id, deletedAt: null, startAt: { gte: since }, status: { not: "CANCELLED" } },
      select: { patientId: true, primaryService: { select: { title: true } } },
    });
    const staff = await prisma.staff.findMany({
      where: { companyId: c.id, isActive: true, deletedAt: null },
      select: { name: true },
    });
    const byKind = new Map<string, { visits: number; people: Set<string> }>();
    const everyone = new Set<string>();
    for (const r of rows) {
      if (r.patientId) everyone.add(r.patientId);
      const kind = r.primaryService ? (serviceKind(r.primaryService.title, staff) ?? "—") : "без услуги";
      if (!byKind.has(kind)) byKind.set(kind, { visits: 0, people: new Set() });
      const k = byKind.get(kind)!;
      k.visits += 1;
      if (r.patientId) k.people.add(r.patientId);
    }
    console.log(`\n${c.name}: приёмов за год ${rows.length}, людей ${everyone.size}`);
    const ranked = [...byKind.entries()].sort((a, b) => b[1].people.size - a[1].people.size);
    for (const [kind, k] of ranked.slice(0, 12)) {
      const ppl = everyone.size ? Math.round((k.people.size / everyone.size) * 100) : 0;
      const vis = rows.length ? Math.round((k.visits / rows.length) * 100) : 0;
      console.log(`  ${kind.padEnd(12)} людей ${String(k.people.size).padStart(5)} (${ppl}%)   приёмов ${String(k.visits).padStart(5)} (${vis}%)`);
    }
    const main = await mainServiceKind(c.id);
    console.log(`  основная услуга для агента: ${main ? main.query : "нет — агент спросит «на какую услугу»"}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
