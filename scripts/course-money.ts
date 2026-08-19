/**
 * Где лежит оплата курса.
 *
 * У пациентки десять сеансов БОС и ни одной оплаты в истории визитов. При
 * этом YCLIENTS помечает эти записи `paid_full: 1`, а одиночная запись
 * показывает стоимость 2 800 ₽ — значит деньги клиника получила, просто не
 * записью приёма.
 *
 * Абонементов API не отдаёт (проверено: пять адресов, все 404). Остаются
 * кассовые операции: у записи есть `visit_id` и документ визита, и если
 * продажа курса проведена через кассу, она должна найтись по ним.
 *
 * Скрипт ничего не меняет. Имён и телефонов не печатает (§7): пациента
 * задают номером записи, а в выводе он остаётся номером.
 *
 *   npx tsx scripts/course-money.ts --record=1911624918
 *   npx tsx scripts/course-money.ts            # возьмёт свежий сеанс курса
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

/** Скрываем всё, что похоже на человека: остаётся форма данных, не данные. */
function mask(value: unknown, key = ""): unknown {
  const personal = /name|phone|email|patronymic|surname|comment|title/i;
  if (personal.test(key)) return value === null || value === undefined ? value : "···";
  if (Array.isArray(value)) return value.map((v) => mask(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, k)]));
  }
  return value;
}

interface Transaction {
  id?: number;
  amount?: number;
  date?: string;
  record_id?: number;
  visit_id?: number;
  client?: { id?: number };
  sold_item_type?: string;
  sold_item_id?: number;
  expense?: { title?: string };
  comment?: string;
}

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const client = await getYclientsClient(company.id);
  if (!client) {
    console.log("Интеграция с YCLIENTS выключена или не заданы ключи.");
    return;
  }
  const cid = client.creds.companyId;

  let recordId = Number(arg("record") ?? 0);
  if (!recordId) {
    const sample = await prisma.appointment.findFirst({
      where: {
        companyId: company.id,
        deletedAt: null,
        status: "ARRIVED",
        revenueSource: "PREPAID",
        yclientsRecordId: { not: null },
      },
      orderBy: { startAt: "desc" },
      select: { yclientsRecordId: true },
    });
    recordId = sample?.yclientsRecordId ?? 0;
  }
  if (!recordId) {
    console.log("Сеансов курса в базе нет — показывать нечего.");
    return;
  }

  const one = await client.get<YclientsRecord & { visit_id?: number; client?: { id?: number } }>(
    client.endpoints.record(cid, recordId),
  );
  const clientId = one.client?.id ?? null;
  const visitId = (one as { visit_id?: number }).visit_id ?? null;
  console.log(`клиника: ${company.name}`);
  console.log(`сеанс: запись ${recordId}, визит ${visitId ?? "—"}, клиент ${clientId ?? "—"}\n`);

  /**
   * Все операции кассы за год. Фильтровать на стороне провайдера нечем:
   * параметры отбора по клиенту он не обещает, а объём за год клиника
   * выдерживает — это тысячи строк, а не миллионы.
   */
  const year = new Date();
  year.setFullYear(year.getFullYear() - 1);
  const from = year.toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);

  let all: Transaction[] = [];
  try {
    all = await client.get<Transaction[]>(client.endpoints.transactions(cid), {
      start_date: from,
      end_date: to,
      count: 1000,
    });
  } catch (e) {
    console.log(`  кассовые операции прочитать не удалось: ${(e as Error).message}`);
  }
  console.log(`── кассовых операций за год: ${all.length} ──`);

  const mine = all.filter((t) => (clientId !== null && t.client?.id === clientId));
  console.log(`   из них по этому клиенту: ${mine.length}\n`);

  if (mine.length === 0) {
    console.log(
      "  ✗ По этому пациенту в кассе нет ничего.\n" +
        "    Значит покупка курса не проведена ни записью, ни кассовой операцией,\n" +
        "    и в API её нет вовсе: показать её платформа не сможет никак.\n",
    );
  } else {
    console.log("── операции этого пациента ──");
    for (const t of [...mine].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))) {
      console.log(
        `  ${t.date ?? "—"} · ${money(t.amount ?? 0)}` +
          ` · продано: ${t.sold_item_type ?? "—"}${t.sold_item_id ? ` #${t.sold_item_id}` : ""}` +
          ` · запись ${t.record_id ?? "—"} · визит ${t.visit_id ?? "—"}`,
      );
    }
    const big = mine.filter((t) => (t.amount ?? 0) >= 10000);
    console.log(
      big.length > 0
        ? `\n  ✓ Крупных оплат: ${big.length}. Похоже на продажу курса — её можно брать\n` +
            "    отсюда: дата, сумма и привязка к клиенту у операции есть."
        : "\n  Крупных оплат нет: курс оплачивался частями или не через кассу.",
    );
  }

  const sample = all[0];
  if (sample) {
    console.log("\n── как выглядит операция (поля, без данных) ──");
    console.log(JSON.stringify(mask(sample), null, 2));
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
