/**
 * Какие услуги клиника продаёт курсом.
 *
 * От этого зависит, как читать нулевую стоимость в записи. У курсовой услуги
 * ноль законен: деньги приняты в день продажи, сеанс их отрабатывает. У
 * обычной ноль означает, что цену забыли проставить, — и это надо показать
 * администратору, а не спрятать за словом «курс».
 *
 * Гадать не будем: смотрим, как услуга ведёт себя в записях. Курсовая
 * выглядит характерно — почти у всех приёмов стоимости нет, а изредка
 * попадается один платный, и он крупный. Так выглядит БОС-терапия: 28 000 ₽
 * в день продажи и девять нулей следом.
 *
 *   npx tsx scripts/courses-detect.ts            # показать, ничего не меняя
 *   npx tsx scripts/courses-detect.ts --apply    # проставить «продаётся курсом»
 *   npx tsx scripts/courses-detect.ts --apply --skip="КОНТРОЛЬ,БОС/персонал"
 *
 * Отметку ставит человек, а не скрипт. «Почти всегда ноль» бывает у трёх
 * разных вещей: у курса, у приёма для сотрудников и у контрольного визита,
 * входящего в стоимость основного. Деньги во всех трёх случаях одинаковы —
 * ноль, — а подпись на экране разная, и выбирает её клиника. Поэтому
 * `--skip` принимает список услуг, которые трогать не надо.
 *
 * Персональных данных не печатает: только услуги и числа (§7).
 */
import "dotenv/config";
import { prisma } from "../lib/db";

/** Ниже этого числа приёмов говорить о повадках услуги не о чем. */
const MIN_VISITS = 10;
/** Доля приёмов без стоимости, с которой услуга похожа на курсовую. */
const ZERO_SHARE = 0.5;

const money = (n: number): string => `${Math.round(n).toLocaleString("ru-RU")} ₽`;

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

/**
 * Все оплаты услуги в одну строку: сколько раз какая сумма встретилась.
 *
 * Медианы мало. По БОС-терапии она показала 2 500 ₽ — цену одного сеанса, и из
 * этого не видно главного: приходит ли вообще продажа курса целиком (28 000 ₽)
 * отдельной записью, или клиника проводит курс как-то иначе. Ответ на этот
 * вопрос меняет то, что мы вправе называть выручкой.
 */
function amountsLine(amounts: number[]): string {
  const counts = new Map<number, number>();
  for (const a of amounts) counts.set(a, (counts.get(a) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shown = sorted.slice(0, 8).map(([sum, n]) => `${money(sum)} × ${n}`);
  const rest = sorted.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, и ещё ${rest} других сумм` : "");
}

/** Медиана — устойчивее среднего: один курс на 30 сеансов не сдвинет ответ. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const skip = new Set(
    (arg("skip") ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  const services = await prisma.service.findMany({
    where: { companyId: company.id },
    select: { id: true, title: true, isCourse: true, defaultSessions: true, price: true },
    orderBy: { title: "asc" },
  });

  const appts = await prisma.appointment.findMany({
    where: { companyId: company.id, deletedAt: null, status: { not: "CANCELLED" } },
    select: {
      patientId: true,
      startAt: true,
      revenue: true,
      revenueSource: true,
      durationMin: true,
      primaryServiceId: true,
      services: { select: { serviceId: true } },
    },
    orderBy: { startAt: "asc" },
  });

  interface Stat {
    total: number;
    zero: number;
    /** Отдано даром по стопроцентной скидке — это не оплата и не курс. */
    gifted: number;
    paidAmounts: number[];
    /** Сеансы каждого пациента подряд после оплаты — оценка длины курса. */
    runs: number[];
    open: Map<string, number>;
  }
  const stats = new Map<string, Stat>();
  const stat = (id: string): Stat => {
    const s = stats.get(id) ?? { total: 0, zero: 0, gifted: 0, paidAmounts: [], runs: [], open: new Map() };
    stats.set(id, s);
    return s;
  };

  for (const a of appts) {
    const ids = new Set(a.services.map((s) => s.serviceId));
    if (ids.size === 0 && a.primaryServiceId) ids.add(a.primaryServiceId);
    // Стоимость записи нулевая — под старым правилом это PRICE_LIST, под новым
    // PREPAID или UNKNOWN. Считаем одинаково: важен сам факт нуля в записи.
    const zero = a.revenueSource !== "RECORD" && a.revenueSource !== "FREE";
    for (const id of ids) {
      const s = stat(id);
      s.total += 1;
      if (zero) {
        s.zero += 1;
        s.open.set(a.patientId, (s.open.get(a.patientId) ?? 0) + 1);
      } else if (a.revenueSource === "FREE") {
        /**
         * Подарок по стопроцентной скидке. В список оплат его класть нельзя:
         * в разбивке он вылезал строкой «0 ₽ × 18» и читался как оплата на
         * ноль рублей — а это ровно противоположное утверждение.
         */
        s.gifted += 1;
      } else {
        s.paidAmounts.push(Number(a.revenue));
        const run = s.open.get(a.patientId);
        if (run !== undefined) s.runs.push(run + 1);
        s.open.set(a.patientId, 0);
      }
    }
  }
  // Курсы, не закрывшиеся к концу истории, тоже говорят о длине.
  for (const s of stats.values()) {
    for (const run of s.open.values()) if (run > 0) s.runs.push(run);
  }

  const rows = services
    .map((sv) => {
      const s = stats.get(sv.id) ?? { total: 0, zero: 0, gifted: 0, paidAmounts: [], runs: [], open: new Map() };
      const share = s.total > 0 ? s.zero / s.total : 0;
      const sessions = Math.max(2, median(s.runs));
      return {
        ...sv,
        total: s.total,
        zero: s.zero,
        gifted: s.gifted,
        share,
        paid: s.paidAmounts,
        sessions,
        /**
         * Курс открывает оплата. Услуга, по которой не заплатили ни разу, курс
         * образовать не может в принципе — сколько бы нулей у неё ни было:
         * подпись «курс» ставится только там, где продажа есть в данных.
         * Предлагать такую услугу бессмысленно.
         */
        looksCourse: s.total >= MIN_VISITS && share >= ZERO_SHARE && s.paidAmounts.length > 0,
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.share - a.share || b.total - a.total);

  console.log(`клиника: ${company.name}\n`);
  console.log("услуга                                        приёмов  без цены   доля  похоже на курс");
  for (const r of rows) {
    const mark = r.looksCourse ? (r.isCourse ? "да (уже стоит)" : "ДА — не отмечена") : r.isCourse ? "нет (а отмечена)" : "—";
    console.log(
      `  ${r.title.slice(0, 42).padEnd(42)} ${String(r.total).padStart(6)} ${String(r.zero).padStart(9)} ${`${Math.round(r.share * 100)}%`.padStart(6)}  ${mark}`,
    );
  }

  const skipped = rows.filter((r) => skip.has(r.title));
  const toMark = rows.filter((r) => r.looksCourse && !r.isCourse && !skip.has(r.title));
  const toUnmark = rows.filter((r) => !r.looksCourse && r.isCourse && !skip.has(r.title));

  console.log("\nчто предлагается:");
  if (toMark.length === 0 && toUnmark.length === 0) {
    console.log("  ничего — справочник уже совпадает с тем, как услуги ведут себя в записях");
  }
  for (const r of toMark) {
    const typical = r.paid.length > 0 ? median(r.paid) : 0;
    const biggest = r.paid.length > 0 ? Math.max(...r.paid) : 0;
    console.log(
      `  ОТМЕТИТЬ курсовой: ${r.title}\n` +
        `    приёмов ${r.total}, из них без стоимости ${r.zero} (${Math.round(r.share * 100)}%)\n` +
        `    сеансов после одной оплаты (медиана): ${r.sessions}\n` +
        (r.gifted > 0 ? `    отдано даром по скидке 100%: ${r.gifted}\n` : "") +
        (typical > 0
          ? `    оплат ${r.paid.length}, типичная ${money(typical)}, наибольшая ${money(biggest)}\n` +
            `    все оплаты: ${amountsLine(r.paid)}\n`
          : "    оплат в истории нет вовсе\n"),
    );
  }
  for (const r of skipped) {
    console.log(`  ПРОПУЩЕНО по --skip: ${r.title}`);
  }
  for (const r of toUnmark) {
    console.log(`  СНЯТЬ отметку курса: ${r.title} — приёмов ${r.total}, без стоимости всего ${r.zero}`);
  }

  if (!apply) {
    console.log("\nэто предпросмотр. Чтобы применить: npx tsx scripts/courses-detect.ts --apply");
    console.log('Отметить не всё: --apply --skip="КОНТРОЛЬ,БОС/персонал"');
    console.log("После этого нужен полный перечёт: npx tsx scripts/yclients-resync.ts --apply");
    return;
  }

  for (const r of toMark) {
    await prisma.service.update({
      where: { id: r.id },
      data: { isCourse: true, defaultSessions: r.defaultSessions ?? r.sessions },
    });
  }
  for (const r of toUnmark) {
    await prisma.service.update({ where: { id: r.id }, data: { isCourse: false } });
  }
  console.log(`\nготово: отмечено курсовыми ${toMark.length}, снято ${toUnmark.length}`);
  console.log("Теперь полный перечёт: npx tsx scripts/yclients-resync.ts --apply");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
