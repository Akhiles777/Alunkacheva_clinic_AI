/**
 * Как называется то, что продали.
 *
 * Кассовая операция говорит «продано goods_transaction #1815455376» и больше
 * ничего: ни услуги, ни названия. Пока названия нет, привязать покупку к
 * услуге можно только догадкой — а догадка о деньгах клиента не должна
 * выглядеть фактом, поэтому сейчас такие продажи просто не разбираются.
 *
 * Название решило бы вопрос начисто: «Курс БОС-терапии, 10 сеансов» —
 * и никаких предположений. Скрипт ищет, откуда его взять: пробует адреса
 * товарных операций и складов, показывает поля ответа.
 *
 * Ничего не меняет. Имена и телефоны скрывает, названия товаров — нет: они
 * персональными данными не являются, а ради них всё и затевается (§7).
 *
 *   npx tsx scripts/goods-probe.ts
 *   npx tsx scripts/goods-probe.ts --sale=1815455376
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { getYclientsClient } from "../lib/integrations/yclients/client";

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

/** Скрываем человека, но не товар: название услуги — то, что мы ищем. */
function mask(value: unknown, key = ""): unknown {
  const personal = /^(name|phone|email|patronymic|surname|display_name|comment)$/i;
  if (personal.test(key)) return value === null || value === undefined ? value : "···";
  if (Array.isArray(value)) return value.map((v) => mask(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, k)]));
  }
  return value;
}

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const client = await getYclientsClient(company.id);
  if (!client) {
    console.log("Интеграция с YCLIENTS выключена или не заданы ключи.");
    return;
  }
  const cid = client.creds.companyId;
  const sale = arg("sale") ?? "1815455376";
  console.log(`клиника: ${company.name} (YCLIENTS ${cid})`);
  console.log(`ищем продажу #${sale}\n`);

  const today = new Date().toISOString().slice(0, 10);
  const yearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const paths: [string, string, Record<string, string | number>][] = [
    ["товарные операции филиала", `/goods_transactions/${cid}`, { count: 3 }],
    ["товарные операции (company)", `/company/${cid}/goods_transactions`, { count: 3 }],
    ["одна товарная операция", `/goods_transactions/${cid}/${sale}`, {}],
    ["операции склада", `/storage_operations/${cid}`, { count: 3 }],
    ["документы", `/documents/${cid}`, { start_date: yearAgo, end_date: today, count: 3 }],
    ["одна кассовая операция", `/transactions/${cid}/${arg("tx") ?? "1653321684"}`, {}],
    ["проданные позиции", `/sold_items/${cid}`, { count: 3 }],
    ["операции по товарам", `/goods_operations/${cid}`, { count: 3 }],
    ["продажи абонементов", `/loyalty/abonements/company/${cid}`, { count: 3 }],
  ];

  for (const [label, path, query] of paths) {
    try {
      const res = await client.getPage<unknown>(path, query);
      const rows = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
      console.log(`  ✓ ${label} (${path}) — записей ${res.totalCount ?? rows.length}`);
      if (rows.length > 0) {
        console.log(`      ${JSON.stringify(mask(rows[0]))}\n`);
      }
    } catch (e) {
      console.log(`  ✗ ${label} (${path}) — ${(e as Error).message}`);
    }
  }

  /**
   * Есть ли курсы в справочнике товаров вообще.
   *
   * Справочник читается — значит, если клиника продаёт курс как товар, он там
   * лежит под своим названием. Это и был бы точный источник: название вместо
   * догадки по сумме. Показываем всё, что дороже цены одного приёма или
   * названо курсом.
   */
  console.log("\n── товары, похожие на курс ──");
  try {
    const goods = await client.get<{ title?: string; actual_cost?: number; cost?: number; good_id?: number }[]>(
      `/goods/${cid}`,
      { count: 1000 },
    );
    const looksCourse = (goods ?? []).filter((g) => {
      const price = Math.max(g.actual_cost ?? 0, g.cost ?? 0);
      return price >= 5000 || /курс|абонемент|сеанс/i.test(g.title ?? "");
    });
    console.log(`  всего товаров: ${goods?.length ?? 0}, похожих на курс: ${looksCourse.length}`);
    for (const g of looksCourse.slice(0, 30)) {
      console.log(
        `    ${g.title ?? "—"} — ${Math.max(g.actual_cost ?? 0, g.cost ?? 0)} ₽ · товар #${g.good_id ?? "—"}`,
      );
    }
    if (looksCourse.length === 0) {
      console.log("    ни одного: курсы продаются не товарами, и названия у продажи нет");
    }
  } catch (e) {
    console.log(`  справочник товаров прочитать не удалось: ${(e as Error).message}`);
  }

  console.log(
    "\nЧто ищем: поле с названием проданного — «Курс БОС-терапии, 10 сеансов»\n" +
      "или ссылку на услугу. Если оно найдётся, привязка курса к услуге станет\n" +
      "точной, и догадки уйдут совсем. Если ни один адрес не отвечает —\n" +
      "названия у продажи нет, и однозначными останутся только те покупки,\n" +
      "после которых пациент ходил на одну курсовую услугу.",
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
