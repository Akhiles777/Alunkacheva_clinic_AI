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
 * Ничего не меняет. Имя пациента печатает — его же и ищем; телефон только
 * последними четырьмя цифрами, тел сообщений не трогает (§7).
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
/** Телефон печатаем последними четырьмя цифрами (§7). */
const tail = (phone: string) => (phone ? `…${phone.slice(-4)}` : "без телефона");

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
      phones: { select: { phone: true }, orderBy: { isPrimary: "desc" } },
    },
  });
  const nameOf = new Map<string, string>();

  console.log(`клиника: ${company.name}`);
  console.log(`── карточек по этому запросу: ${patients.length} ──`);
  for (const p of patients) {
    console.log(
      `  ${p.name ?? "без имени"} · ${tail(p.phones[0]?.phone ?? "")}` +
        ` · YCLIENTS ${p.yclientsId ?? "—"} · визитов ${p._count.appointments}` +
        `${p.deletedAt ? " · удалена" : ""}`,
    );
  }
  if (patients.length === 0) return;

  /**
   * Дубль — это общий телефон, а не общее имя.
   *
   * Поиск по имени находит однофамильцев и тёзок: на «Самира» пришло пять
   * карточек пяти разных людей, а скрипт объявил их задвоением одного. Ключ
   * пациента — телефон в E.164 (§4), по нему и судим.
   */
  const byPhone = new Map<string, string[]>();
  for (const p of patients) {
    for (const ph of p.phones) {
      byPhone.set(ph.phone, [...(byPhone.get(ph.phone) ?? []), p.id]);
    }
  }
  const shared = [...byPhone.entries()].filter(([, ids]) => new Set(ids).size > 1);
  if (shared.length > 0) {
    console.log(
      `  ! карточки с общим телефоном: ${shared.map(([ph]) => tail(ph)).join(", ")} —\n` +
        "    это один человек, склеить: npx tsx scripts/patients-merge.ts",
    );
  } else if (patients.length > 1) {
    console.log("  (телефоны разные — это разные люди, просто с похожими именами)");
  }

  const ids = patients.map((p) => p.id);
  const purchases = await prisma.coursePurchase.findMany({
    where: { companyId: company.id, patientId: { in: ids } },
    orderBy: { purchasedAt: "asc" },
    select: {
      patientId: true,
      yclientsSaleId: true,
      amount: true,
      purchasedAt: true,
      isCourse: true,
      courseId: true,
      service: { select: { title: true, defaultSessions: true } },
    },
  });
  for (const p of patients) nameOf.set(p.id, `${p.name ?? "без имени"} ${tail(p.phones[0]?.phone ?? "")}`);
  console.log(`\n── наши покупки: ${purchases.length} ──`);
  for (const p of purchases) {
    console.log(
      `  ${day(p.purchasedAt)} · ${money(Number(p.amount))} · продажа #${p.yclientsSaleId}` +
        ` · ${p.service?.title ?? "услуга не определена"}` +
        ` · ${p.courseId ? "курс собран" : "курса ещё нет"}${p.isCourse ? "" : " · не курс"}` +
        // Чья именно покупка: карточек по запросу может быть несколько.
        (patients.length > 1 ? ` · ${nameOf.get(p.patientId) ?? ""}` : ""),
    );
  }

  const courses = await prisma.course.findMany({
    where: { companyId: company.id, patientId: { in: ids } },
    orderBy: { purchasedAt: "asc" },
    select: {
      patientId: true,
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
        ` · ${money(Number(c.amount))} · ${c.origin === "YCLIENTS" ? "куплен в кассе" : "оплачен записью"}` +
        (patients.length > 1 ? ` · ${nameOf.get(c.patientId) ?? ""}` : ""),
    );
  }

  /**
   * Сеансы курсовых услуг — почему у одного из них стоит сумма.
   *
   * На экране дня сеанс курса подписан «курс 3/10», а рядом такой же приём той
   * же услуги показывает 2 800 ₽. Разница всегда в записи YCLIENTS: у сеанса
   * оплаченного курса стоимость нулевая, а если администратор пробил приём
   * отдельно, сумма в записи есть — и это настоящие деньги дня, а не ошибка.
   *
   * Второй случай — сеансы сверх курса: курс на десять, а пришли одиннадцать
   * раз. Одиннадцатый ни к какому курсу не относится и стоит своих денег.
   *
   * Печатаем всё подряд, чтобы различать это числами, а не догадками.
   */
  const courseServiceIds = new Set(
    (
      await prisma.service.findMany({
        where: { companyId: company.id, isCourse: true },
        select: { id: true },
      })
    ).map((x) => x.id),
  );
  const sessions = await prisma.appointment.findMany({
    where: {
      companyId: company.id,
      patientId: { in: ids },
      deletedAt: null,
      status: { not: "CANCELLED" },
      OR: [
        { primaryServiceId: { in: [...courseServiceIds] } },
        { services: { some: { serviceId: { in: [...courseServiceIds] } } } },
      ],
    },
    orderBy: { startAt: "asc" },
    select: {
      startAt: true,
      status: true,
      revenue: true,
      revenueSource: true,
      courseId: true,
      staff: { select: { name: true } },
      primaryService: { select: { title: true } },
      services: { select: { service: { select: { title: true, isCourse: true } } } },
    },
  });

  console.log(`\n── сеансы курсовых услуг: ${sessions.length} ──`);
  /**
   * Сколько сеансов куплено по каждой услуге.
   *
   * Считаем по ПОКУПКАМ, а не по собравшимся курсам. Курс собирается, только
   * когда пациент начал ходить; покупка, которая курса ещё не образовала, —
   * это тоже оплаченные сеансы. Пока их не считали, третья покупка выпадала
   * из знаменателя, и десять законных сеансов подписывались как «сверх курса».
   */
  const boughtByService = new Map<string, number>();
  for (const c of courses) {
    boughtByService.set(c.service.title, (boughtByService.get(c.service.title) ?? 0) + c.sessionsTotal);
  }
  for (const p of purchases) {
    if (p.courseId || !p.isCourse || !p.service) continue;
    const size = p.service.defaultSessions ?? 0;
    if (size <= 0) continue;
    boughtByService.set(p.service.title, (boughtByService.get(p.service.title) ?? 0) + size);
  }
  const seenByService = new Map<string, number>();
  for (const a of sessions) {
    const title =
      a.services.find((x) => x.service.isCourse)?.service.title ??
      a.primaryService?.title ??
      "услуга не указана";
    const n = (seenByService.get(title) ?? 0) + 1;
    seenByService.set(title, n);
    const bought = boughtByService.get(title) ?? 0;

    /**
     * Причину называем прямо. «Не привязан» без объяснения — это то же
     * молчание, из-за которого приходится лезть в YCLIENTS руками.
     */
    let why: string;
    if (a.courseId) why = "сеанс курса";
    else if (a.status !== "ARRIVED")
      /**
       * Приём ещё не состоялся: цена в записи — план из прайса, деньги за него
       * не приняты. При закрытии сеанса на курс она обнулится.
       */
      why = `предстоит (${a.status}): цена из прайса, деньги ещё не приняты`;
    else if (Number(a.revenue) > 0)
      why =
        bought > 0 && n > bought
          ? `ОПЛАЧЕН ОТДЕЛЬНО, сеанс ${n} при купленных ${bought} — курс кончился`
          : "ОПЛАЧЕН ОТДЕЛЬНО: в записи YCLIENTS стоит сумма";
    else
      why =
        bought === 0
          ? "курса нет: покупка не найдена в кассе"
          : `не привязан: сеанс ${n} при купленных ${bought}`;

    console.log(
      `  ${day(a.startAt)} · ${title} · ${money(Number(a.revenue))} · ${a.revenueSource}` +
        ` · ${a.status} · ${a.staff?.name ?? "без специалиста"} — ${why}`,
    );
  }
  /**
   * Двойной счёт: приём закрыт ценой, хотя сеанс был оплачен курсом.
   *
   * Живой случай: пациентка купила три курса БОС — 30 сеансов, — и ровно 30
   * сеансов у неё и есть. Но два приёма администратор закрыл не на курс, а
   * ценой из прайса, и YCLIENTS показывает по ним 2 800 ₽. Деньги за эти
   * сеансы клиника получила при покупке курса, и выручка дня оказывается
   * больше настоящей.
   *
   * Сами суммы не трогаем: YCLIENTS — источник истины по деньгам (§2), и наше
   * дело показать расхождение, а не переписать его. Чинится это в YCLIENTS
   * одним действием — переоформить приём на курс.
   */
  for (const [title, bought] of boughtByService) {
    const all = sessions.filter(
      (a) =>
        (a.services.find((x) => x.service.isCourse)?.service.title ??
          a.primaryService?.title ??
          "услуга не указана") === title,
    );
    if (all.length > bought) continue;
    const paid = all.filter((a) => a.status === "ARRIVED" && Number(a.revenue) > 0);
    if (paid.length === 0) continue;
    const sum = paid.reduce((acc, a) => acc + Number(a.revenue), 0);
    console.log(
      `\n  ! ${title}: оплачено ${bought} сеансов, всего сеансов ${all.length},\n` +
        `    но ${paid.length} приёмов закрыты ценой из прайса на ${money(sum)}.\n` +
        "    Похоже на двойной счёт: деньги за эти сеансы уже получены при покупке курса.\n" +
        `    Дни: ${paid.map((a) => day(a.startAt)).join(", ")}.\n` +
        "    Проверьте в YCLIENTS: приём должен быть закрыт на курс, а не по прайсу.",
    );
  }

  for (const [title, bought] of boughtByService) {
    // Считаем только состоявшиеся: предстоящие сеансы курс ещё не потратили.
    const seen = sessions.filter(
      (a) =>
        a.status === "ARRIVED" &&
        (a.services.find((x) => x.service.isCourse)?.service.title ??
          a.primaryService?.title ??
          "услуга не указана") === title,
    ).length;
    if (seen > bought) {
      console.log(
        `  ! ${title}: сеансов ${seen}, куплено ${bought} — ${seen - bought} сверх курса.` +
          " Каждый сверх курса стоит своих денег, это не ошибка привязки.",
      );
    }
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
