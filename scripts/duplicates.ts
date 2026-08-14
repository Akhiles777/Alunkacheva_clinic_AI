/**
 * Дубли пациентов: кто продублировался и почему.
 *
 * Телефон — единственный надёжный ключ пациента (§4). Но карточка может
 * появиться и без него: её заводит администратор из диалога, её создаёт агент
 * до того, как человек назвал номер, её приносит выгрузка YCLIENTS. Тогда один
 * и тот же человек оказывается в базе дважды, и ассистент разговаривает с ним
 * как с незнакомым — не потому, что забыл, а потому что это для него другая
 * карточка.
 *
 * Скрипт показывает такие пары и происхождение каждой стороны: есть ли
 * телефон, есть ли связь с YCLIENTS, есть ли визиты и переписка. По этому
 * видно, что склеивать и в какую сторону.
 *
 * Персональные данные печатаются в сокращённом виде: имя нужно, чтобы
 * опознать пару, телефон — только последние четыре цифры.
 *
 *   npx tsx scripts/duplicates.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";

/** «+79881234567» → «…4567». Для опознания хватает, для утечки — нет. */
function tail(phone: string | null): string {
  return phone ? `…${phone.slice(-4)}` : "нет телефона";
}

function normalizeName(name: string | null): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const patients = await prisma.patient.findMany({
    where: { companyId: company.id, deletedAt: null },
    select: {
      id: true,
      name: true,
      yclientsId: true,
      firstSeenAt: true,
      phones: { select: { phone: true, isPrimary: true } },
      _count: { select: { appointments: true, conversations: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`пациентов в базе: ${patients.length}`);

  /** Пары по совпадающему имени: самый частый вид дубля. */
  const byName = new Map<string, typeof patients>();
  for (const p of patients) {
    const key = normalizeName(p.name);
    if (!key) continue;
    const list = byName.get(key);
    if (list) list.push(p);
    else byName.set(key, [p]);
  }

  const dupNames = [...byName.entries()].filter(([, list]) => list.length > 1);
  console.log(`\n═══ ОДИНАКОВЫЕ ИМЕНА: ${dupNames.length} ═══`);
  for (const [, list] of dupNames.slice(0, 40)) {
    console.log(`\n${list[0].name}`);
    for (const p of list) {
      const phones = p.phones.map((ph) => tail(ph.phone)).join(", ") || "нет телефона";
      const origin = p.yclientsId ? `YCLIENTS #${p.yclientsId}` : "заведён у нас";
      console.log(
        `  ${p.id}  ${phones.padEnd(22)} ${origin.padEnd(20)} ` +
          `визитов ${p._count.appointments}, диалогов ${p._count.conversations}, ` +
          `с ${p.firstSeenAt.toISOString().slice(0, 10)}`,
      );
    }
  }

  /**
   * Карточки без телефона — будущие дубли. Пока номера нет, сопоставить
   * человека не с чем, и следующее обращение заведёт ещё одну.
   */
  const noPhone = patients.filter((p) => p.phones.length === 0);
  console.log(`\n═══ БЕЗ ТЕЛЕФОНА: ${noPhone.length} ═══`);
  for (const p of noPhone.slice(0, 30)) {
    console.log(
      `  ${p.id}  ${(p.name ?? "(без имени)").padEnd(34)} ` +
        `${p.yclientsId ? `YCLIENTS #${p.yclientsId}` : "заведён у нас"}, ` +
        `визитов ${p._count.appointments}, диалогов ${p._count.conversations}`,
    );
  }

  /** Один и тот же номер на разных карточках — прямая ошибка сопоставления. */
  const byPhone = new Map<string, string[]>();
  for (const p of patients) {
    for (const ph of p.phones) {
      const list = byPhone.get(ph.phone);
      if (list) list.push(p.id);
      else byPhone.set(ph.phone, [p.id]);
    }
  }
  const dupPhones = [...byPhone.entries()].filter(([, ids]) => new Set(ids).size > 1);
  console.log(`\n═══ ОДИН НОМЕР У РАЗНЫХ КАРТОЧЕК: ${dupPhones.length} ═══`);
  for (const [phone, ids] of dupPhones.slice(0, 20)) {
    console.log(`  ${tail(phone)} → ${[...new Set(ids)].join(", ")}`);
  }

  /** Диалоги без карточки: следующая реплика заведёт нового пациента. */
  const orphanDialogs = await prisma.conversation.count({
    where: { companyId: company.id, patientId: null },
  });
  console.log(`\nдиалогов без карточки пациента: ${orphanDialogs}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("разбор упал:", e);
  await prisma.$disconnect();
  process.exit(1);
});
