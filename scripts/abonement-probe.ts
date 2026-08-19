/**
 * Есть ли в YCLIENTS абонементы — и видим ли мы их.
 *
 * У клиники сотни сеансов БОС с нулевой стоимостью, перед которыми нет ни
 * одной оплаты в записях. Курс из них не собирается, и это честно: продажи в
 * наших данных нет. Но она где-то есть — в YCLIENTS для этого заведены
 * абонементы, и мы их не читаем.
 *
 * Скрипт ничего не меняет. Он делает две вещи:
 *
 *   1. Показывает СЫРУЮ запись сеанса с нулевой стоимостью целиком — какие
 *      поля провайдер про неё вообще присылает. Если там есть ссылка на
 *      абонемент, никакой новый эндпоинт не нужен.
 *   2. Пробует адреса абонементов и говорит, что каждый ответил.
 *
 * Персональные данные маскируются: имя и телефон не печатаются (§7).
 *
 *   npx tsx scripts/abonement-probe.ts
 *   npx tsx scripts/abonement-probe.ts --record=1899363417
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { getYclientsClient } from "../lib/integrations/yclients/client";

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

/** Скрываем всё, что похоже на человека: остаётся форма данных, не данные. */
function mask(value: unknown, key = ""): unknown {
  const personal = /name|phone|email|patronymic|surname|comment|client_comment/i;
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
  console.log(`клиника: ${company.name} (YCLIENTS ${cid})\n`);

  // ── 1. Сырая запись сеанса без стоимости
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
    console.log("── сырая запись ──\n  сеансов курса в базе нет, показывать нечего\n");
  } else {
    console.log(`── сырая запись ${recordId} (сеанс с нулевой стоимостью) ──`);
    try {
      const raw = await client.get<unknown>(client.endpoints.record(cid, recordId));
      console.log(JSON.stringify(mask(raw), null, 2));
      const text = JSON.stringify(raw);
      const hints = ["abonement", "loyalty", "certificate", "subscription", "pass"].filter((w) =>
        text.toLowerCase().includes(w),
      );
      console.log(
        hints.length > 0
          ? `\n  ✓ в записи есть упоминания: ${hints.join(", ")} — источник курса найден`
          : "\n  ✗ ни абонемента, ни лояльности в записи нет: продажа курса лежит не здесь",
      );
    } catch (e) {
      console.log(`  ошибка чтения: ${(e as Error).message}`);
    }
  }

  // ── 2. Адреса абонементов
  console.log("\n── адреса абонементов ──");
  const paths: [string, string][] = [
    ["абонементы филиала", `/loyalty/abonements/${cid}`],
    ["абонементы (короткий адрес)", `/abonements/${cid}`],
    ["типы абонементов", `/loyalty/abonement_types/${cid}`],
    ["сертификаты", `/loyalty/certificates/${cid}`],
    ["продажи лояльности", `/loyalty/sold_items/${cid}`],
  ];
  for (const [label, path] of paths) {
    try {
      const res = await client.getPage<unknown>(path, { count: 5 });
      const rows = Array.isArray(res.data) ? res.data : [];
      console.log(`  ✓ ${label} (${path}) — записей ${res.totalCount ?? rows.length}`);
      if (rows.length > 0) console.log(`      ${JSON.stringify(mask(rows[0]))}`);
    } catch (e) {
      console.log(`  ✗ ${label} (${path}) — ${(e as Error).message}`);
    }
  }

  console.log(
    "\nЧто с этим делать. Если абонементы читаются — курс можно брать оттуда:\n" +
      "продажа, число сеансов и остаток придут от YCLIENTS, и гадать по оплатам\n" +
      "в записях больше не придётся. Если ни один адрес не отвечает — источника\n" +
      "продажи курса у нас нет, и сеансы честнее показывать бесплатными.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
