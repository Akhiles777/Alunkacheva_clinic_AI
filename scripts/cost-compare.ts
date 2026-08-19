/**
 * Одинаковую ли стоимость отдают список записей и одиночная запись.
 *
 * Разведка абонементов показала неожиданное: в одиночной записи сеанса БОС
 * стоит `cost: 2800` и `paid_full: 1`, а у нас этот же визит записан нулём —
 * значит список записей, из которого мы читаем выгрузку, отдаёт по нему ноль.
 *
 * Разница между двумя ответами провайдера — это либо объяснение (деньги
 * приняты раньше, за курс), либо потеря выручки. Отличить можно только
 * сравнением, поэтому сравниваем: тот же день, те же записи, два источника.
 *
 * Ничего не меняет. Персональных данных не печатает (§7).
 *
 *   npx tsx scripts/cost-compare.ts --day=2026-08-19
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { getYclientsClient } from "../lib/integrations/yclients/client";
import type { YclientsRecord } from "../lib/integrations/yclients/types";

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;
const sumCost = (r: YclientsRecord): number =>
  (r.services ?? []).reduce((s, sv) => s + (sv.cost ?? 0), 0);

async function main() {
  const day = arg("day") ?? new Date().toISOString().slice(0, 10);
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const client = await getYclientsClient(company.id);
  if (!client) {
    console.log("Интеграция с YCLIENTS выключена или не заданы ключи.");
    return;
  }
  const cid = client.creds.companyId;
  console.log(`клиника: ${company.name}\nдень: ${day}\n`);

  const list = await client.get<YclientsRecord[]>(client.endpoints.records(cid), {
    start_date: day,
    end_date: day,
    count: 200,
  });
  const records = (list ?? []).filter((r) => !r.deleted);
  console.log(`записей в списке: ${records.length}\n`);

  let listTotal = 0;
  let oneTotal = 0;
  const diffs: { id: number; list: number; one: number; paid: boolean; title: string }[] = [];

  for (const r of records) {
    const fromList = sumCost(r);
    listTotal += fromList;
    let one: YclientsRecord | null = null;
    try {
      one = await client.get<YclientsRecord>(client.endpoints.record(cid, r.id));
    } catch {
      one = null;
    }
    const fromOne = one ? sumCost(one) : fromList;
    oneTotal += fromOne;
    if (Math.abs(fromOne - fromList) > 0.005) {
      diffs.push({
        id: r.id,
        list: fromList,
        one: fromOne,
        paid: (one?.paid_full ?? r.paid_full) === 1,
        title: (one ?? r).services?.[0]?.title ?? "услуга не указана",
      });
    }
  }

  console.log("── итоги дня по двум источникам ──");
  console.log(`  по списку записей:   ${money(listTotal)}   ← отсюда читает выгрузка`);
  console.log(`  по одиночным:        ${money(oneTotal)}`);
  console.log(`  разница:             ${money(oneTotal - listTotal)}\n`);

  if (diffs.length === 0) {
    console.log("  ✓ оба источника согласны по каждой записи — выручка читается верно");
  } else {
    console.log(`── записи, где источники расходятся: ${diffs.length} ──`);
    for (const d of diffs) {
      console.log(
        `  ${d.title}: список ${money(d.list)}, одиночная ${money(d.one)}` +
          ` · оплачено: ${d.paid ? "да" : "нет"} · запись ${d.id}`,
      );
    }
    const allPaid = diffs.every((d) => d.paid);
    console.log(
      allPaid
        ? "\n  Все расхождения — на оплаченных записях. Это и есть сеансы курса:\n" +
            "  стоимость у услуги известна, но деньги приняты не в этот день.\n" +
            "  Список отдаёт ноль именно поэтому, и выручка дня читается верно."
        : "\n  ✗ Есть расхождения на НЕоплаченных записях — это уже похоже на потерю\n" +
            "  выручки: провайдер знает стоимость, а список её не отдаёт.",
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
