/**
 * Услуга и стоимость: что говорит YCLIENTS против того, что лежит у нас.
 *
 * Жалоба «на многих приёмах не указана услуга и стоимость» неразрешима на
 * глаз: по экрану не отличить «в записи так и есть» от «мы это потеряли».
 * Скрипт читает сырые записи и сверяет по каждой ровно две вещи — название
 * основной услуги и сумму. Расхождения печатает построчно с номером записи.
 *
 * Ничего не меняет. Имён и телефонов не печатает (§7).
 *
 *   npx tsx scripts/visits-diff.ts              — за 30 дней
 *   npx tsx scripts/visits-diff.ts --days=90
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { getYclientsClient } from "../lib/integrations/yclients/client";
import { apiDate, hasNextPage, monthWindows, PAGE_SIZE } from "../lib/integrations/yclients/paging";
import { recordRevenue } from "../lib/integrations/yclients/mappers";
import type { YclientsRecord } from "../lib/integrations/yclients/types";

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = Number(daysArg?.slice(7) ?? 30);
const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;

async function main() {
  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  const now = new Date();
  const from = new Date(now.getTime() - DAYS * 24 * 3600 * 1000);
  console.log(`клиника: ${company.name}`);
  console.log(`период: ${apiDate(from)} — ${apiDate(now)}\n`);

  const client = await getYclientsClient(company.id);
  if (!client) {
    console.log("YCLIENTS выключен — сверять не с чем.");
    await prisma.$disconnect();
    return;
  }

  /** Что YCLIENTS говорит про каждую запись: услуга и сумма. */
  const theirs = new Map<number, { service: string | null; amount: number; services: number }>();
  for (const w of monthWindows(from, now)) {
    let page = 1;
    let fetched = 0;
    for (;;) {
      const res = await client.getPage<YclientsRecord[]>(
        client.endpoints.records(client.creds.companyId),
        { start_date: apiDate(w.from), end_date: apiDate(w.to), page, count: PAGE_SIZE },
      );
      const dtos = res.data ?? [];
      for (const d of dtos) {
        const svc = d.services ?? [];
        theirs.set(d.id, {
          service: svc[0]?.title?.trim() || null,
          amount: recordRevenue(d).amount,
          services: svc.length,
        });
      }
      fetched += dtos.length;
      if (!hasNextPage({ received: dtos.length, pageSize: PAGE_SIZE, fetchedSoFar: fetched, totalCount: res.totalCount, page })) break;
      page += 1;
    }
  }

  const ours = await prisma.appointment.findMany({
    where: {
      companyId: company.id,
      deletedAt: null,
      startAt: { gte: from, lt: now },
      yclientsRecordId: { not: null },
    },
    select: {
      yclientsRecordId: true,
      startAt: true,
      status: true,
      revenue: true,
      revenueSource: true,
      courseId: true,
      primaryService: { select: { title: true } },
      services: { select: { priceCharged: true } },
    },
    orderBy: { startAt: "asc" },
  });

  console.log(`записей у YCLIENTS: ${theirs.size} · у нас: ${ours.length}\n`);

  const noService: typeof ours = [];
  const priceDiff: { row: (typeof ours)[number]; their: number }[] = [];
  let composed = 0;

  for (const a of ours) {
    const t = theirs.get(a.yclientsRecordId as number);
    if (!t) continue;

    // Услуга: у нас пусто, а у них названа — это наша потеря.
    if (!a.primaryService && t.services > 0) noService.push(a);

    /**
     * Сумма. Расхождение законно ровно в одном случае: сеанс покрыт
     * оплаченным курсом, и мы намеренно снимаем его цену — деньги за него
     * клиника получила в день продажи курса (§8). Всё остальное — дефект.
     */
    const oursAmount = Number(a.revenue);
    const composedSum = a.services.reduce((s, x) => s + Number(x.priceCharged), 0);
    if (a.services.length > 0 && Math.abs(composedSum - oursAmount) > 0.5) composed += 1;
    if (Math.abs(t.amount - oursAmount) > 0.5 && a.courseId === null && a.revenueSource !== "PREPAID") {
      priceDiff.push({ row: a, their: t.amount });
    }
  }

  console.log("── услуга потеряна у нас ──");
  if (noService.length === 0) {
    console.log("  ✓ ни одной: где услуга названа в YCLIENTS, она есть и у нас");
  } else {
    for (const a of noService.slice(0, 30)) {
      console.log(
        `  запись ${a.yclientsRecordId} · ${a.startAt.toISOString().slice(0, 16)} · ${a.status}` +
          ` — YCLIENTS называет «${theirs.get(a.yclientsRecordId as number)?.service ?? "?"}»`,
      );
    }
    console.log(`  всего ${noService.length}. Услуги нет в нашем справочнике — нужна выгрузка справочников.`);
  }

  console.log("\n── сумма расходится с YCLIENTS ──");
  if (priceDiff.length === 0) {
    console.log("  ✓ ни одной: суммы совпадают всюду, кроме сеансов курса (там ноль законен)");
  } else {
    for (const d of priceDiff.slice(0, 30)) {
      console.log(
        `  запись ${d.row.yclientsRecordId} · ${d.row.startAt.toISOString().slice(0, 16)}` +
          ` · у них ${money(d.their)} · у нас ${money(Number(d.row.revenue))} (${d.row.revenueSource})`,
      );
    }
    console.log(`  всего ${priceDiff.length}`);
  }

  console.log(
    composed === 0
      ? "\n  ✓ состав визитов сходится с их суммой"
      : `\n  ✗ у ${composed} визитов состав не сходится с суммой`,
  );

  /**
   * Записи, где услуги нет и в YCLIENTS. Их не чинит никакая выгрузка —
   * услугу выбирают в самой записи.
   */
  const blankThere = ours.filter((a) => {
    const t = theirs.get(a.yclientsRecordId as number);
    return t && t.services === 0;
  });
  console.log(
    blankThere.length === 0
      ? "  ✓ записей без услуги нет и в YCLIENTS"
      : `\n── услуга не выбрана в самом YCLIENTS: ${blankThere.length} ──\n` +
          blankThere
            .slice(0, 20)
            .map((a) => `  запись ${a.yclientsRecordId} · ${a.startAt.toISOString().slice(0, 16)} · ${a.status}`)
            .join("\n") +
          "\n  Правится в YCLIENTS: открыть запись и выбрать услугу.",
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
