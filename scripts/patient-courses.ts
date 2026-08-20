/**
 * Курсы и покупки одного пациента — до последней кассовой строки.
 *
 * В карточке появились две покупки курса в один день: 26 000 ₽ и 28 000 ₽.
 * Либо клиника правда продала два курса, либо у нас задвоилось — и различить
 * это можно только сырыми операциями кассы.
 *
 * Скрипт показывает три слоя подряд:
 *
 *   1. Карточки пациента с этим именем или телефоном — их может быть больше
 *      одной, и тогда покупки одного человека приходят с двух клиентов
 *      YCLIENTS.
 *   2. Наши покупки и курсы: номер продажи, сумма, день, к чему привязана.
 *   3. Сырые операции кассы по каждому клиенту YCLIENTS: та же сумма и тот же
 *      номер продажи, как их отдаёт провайдер.
 *
 * Ничего не меняет. Имя пациента печатает — его же и ищем; телефон и тела
 * сообщений не трогает (§7).
 *
 *   npx tsx scripts/patient-courses.ts --name="Багаутдинова"
 *   npx tsx scripts/patient-courses.ts --phone=79280000000
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { getYclientsClient } from "../lib/integrations/yclients/client";

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;
const day = (d: Date) => d.toISOString().slice(0, 10);

interface Transaction {
  id?: number;
  date?: string;
  amount?: number;
  client?: { id?: number } | unknown[] | null;
  sold_item_id?: number;
  sold_item_type?: string | null;
  record_id?: number;
  visit_id?: number;
}

async function main() {
  const name = arg("name");
  const phone = arg("phone")?.replace(/\D/g, "");
  if (!name && !phone) {
    console.log('Укажите пациента: --name="Фамилия" или --phone=79280000000');
    return;
  }
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const patients = await prisma.patient.findMany({
    where: {
      companyId: company.id,
      ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
      ...(phone ? { phones: { some: { phone: { contains: phone } } } } : {}),
    },
    select: {
      id: true,
      name: true,
      yclientsId: true,
      deletedAt: true,
      _count: { select: { appointments: true } },
    },
  });

  console.log(`клиника: ${company.name}`);
  console.log(`── карточек пациента найдено: ${patients.length} ──`);
  for (const p of patients) {
    console.log(
      `  ${p.name ?? "без имени"} · YCLIENTS ${p.yclientsId ?? "—"} · визитов ${p._count.appointments}` +
        `${p.deletedAt ? " · удалена" : ""}`,
    );
  }
  if (patients.length > 1) {
    console.log(
      "  ! карточек больше одной: покупки одного человека приходят с разных\n" +
        "    клиентов YCLIENTS, и в одной карточке их видно вдвое больше",
    );
  }
  if (patients.length === 0) return;

  const ids = patients.map((p) => p.id);
  const purchases = await prisma.coursePurchase.findMany({
    where: { companyId: company.id, patientId: { in: ids } },
    orderBy: { purchasedAt: "asc" },
    select: {
      yclientsSaleId: true,
      amount: true,
      purchasedAt: true,
      isCourse: true,
      courseId: true,
      service: { select: { title: true } },
    },
  });
  console.log(`\n── наши покупки: ${purchases.length} ──`);
  for (const p of purchases) {
    console.log(
      `  ${day(p.purchasedAt)} · ${money(Number(p.amount))} · продажа #${p.yclientsSaleId}` +
        ` · ${p.service?.title ?? "услуга не определена"}` +
        ` · ${p.courseId ? "курс собран" : "курса ещё нет"}${p.isCourse ? "" : " · не курс"}`,
    );
  }

  const courses = await prisma.course.findMany({
    where: { companyId: company.id, patientId: { in: ids } },
    orderBy: { purchasedAt: "asc" },
    select: {
      purchasedAt: true,
      amount: true,
      sessionsTotal: true,
      sessionsUsed: true,
      origin: true,
      service: { select: { title: true } },
    },
  });
  console.log(`\n── наши курсы: ${courses.length} ──`);
  for (const c of courses) {
    console.log(
      `  ${day(c.purchasedAt)} · ${c.service.title} · ${c.sessionsUsed}/${c.sessionsTotal}` +
        ` · ${money(Number(c.amount))} · ${c.origin === "YCLIENTS" ? "куплен в кассе" : "оплачен записью"}`,
    );
  }

  const client = await getYclientsClient(company.id);
  const yclientsIds = patients.map((p) => p.yclientsId).filter((x): x is number => Boolean(x));
  if (!client || yclientsIds.length === 0) {
    console.log("\nСырые операции кассы недоступны: нет ключей или клиент не связан с YCLIENTS.");
    await prisma.$disconnect();
    return;
  }

  /**
   * Кассу читаем страницами.
   *
   * Одной тысячей операций два года не покрываются: мартовская покупка в
   * вывод не попадала, и разведка молча говорила «в кассе её нет». Диагностика,
   * которая не видит половину данных, хуже её отсутствия.
   */
  const from = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000);
  const all: Transaction[] = [];
  for (let page = 1; page <= 40; page += 1) {
    const chunk = await client
      .get<Transaction[]>(client.endpoints.transactions(client.creds.companyId), {
        start_date: day(from),
        end_date: day(new Date()),
        page,
        count: 200,
      })
      .catch(() => [] as Transaction[]);
    if (!chunk || chunk.length === 0) break;
    all.push(...chunk);
    if (chunk.length < 200) break;
  }
  console.log(`\n(прочитано операций кассы за два года: ${all.length})`);

  const seen = new Set<number>();
  const mine = all.filter((t) => {
    // Страницы могут прийти внахлёст: одна операция — одна строка.
    if (typeof t.id === "number") {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
    }
    const c = t.client;
    if (!c || Array.isArray(c)) return false;
    const id = (c as { id?: number }).id;
    return typeof id === "number" && yclientsIds.includes(id);
  });

  console.log(`\n── сырые операции кассы по этому человеку: ${mine.length} ──`);
  for (const t of mine.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))) {
    console.log(
      `  ${t.date ?? "—"} · ${money(t.amount ?? 0)} · продажа #${t.sold_item_id ?? "—"}` +
        ` · вид ${t.sold_item_type ?? "—"} · запись ${t.record_id ?? 0} · операция #${t.id ?? "—"}`,
    );
  }
  console.log(
    "\nКак читать: строки с ОДНИМ номером продажи — одна покупка, их суммы\n" +
      "складываются. Разные номера — разные покупки. Если наших покупок больше,\n" +
      "чем номеров продаж, задвоение у нас; если столько же — клиника правда\n" +
      "продала два курса.",
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
