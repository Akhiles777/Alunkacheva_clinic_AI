/**
 * Разбор месячных цифр: откуда каждая берётся и почему они расходятся.
 *
 * Написан на вопрос владельца: «новых пациентов 584, записались 240 — значит
 * 344 обратились и не записались?». Нет, не значит: это разные множества,
 * посчитанные по разным полям, и складывать их в воронку нельзя.
 *
 *   Новые пациенты — карточки, у которых дата первого обращения попала в месяц.
 *   Записались     — визиты месяца со статусом кроме отменённого.
 *   Пришли         — из них те, где администратор отметил посещение.
 *   Первичные      — первый в истории пациента состоявшийся визит.
 *
 * Главная ловушка — дата первого обращения у выгруженных карточек. Выгрузка
 * ставит её по первому визиту, но у клиента без визитов брать неоткуда, и там
 * остаётся день выгрузки. Все такие карточки становятся «новыми» в месяце,
 * когда выгрузку запустили. Скрипт показывает это прямо: если в каком-то дне
 * месяца всплеск на сотни человек — это он и есть.
 *
 * Персональные данные не печатаются.
 *
 *   npx tsx scripts/metrics-month.ts                # текущий месяц
 *   npx tsx scripts/metrics-month.ts --month=2026-08
 */
import "dotenv/config";
import { prisma } from "../lib/db";

function monthArg(): { from: Date; to: Date; label: string } {
  const raw = process.argv.find((a) => a.startsWith("--month="))?.split("=")[1];
  const now = new Date();
  const [y, m] = raw?.match(/^(\d{4})-(\d{2})$/)
    ? [Number(raw.slice(0, 4)), Number(raw.slice(5, 7))]
    : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  return { from, to, label: `${y}-${String(m).padStart(2, "0")}` };
}

const money = (v: number) => `${Math.round(v).toLocaleString("ru-RU")} ₽`;

async function main() {
  const { from, to, label } = monthArg();
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  console.log(`клиника: ${company.name}, месяц: ${label}`);

  // ── Новые пациенты: по дате первого обращения
  const newPatients = await prisma.patient.findMany({
    where: { companyId: company.id, deletedAt: null, firstSeenAt: { gte: from, lt: to } },
    select: { id: true, firstSeenAt: true, _count: { select: { appointments: true } } },
  });
  const withVisits = newPatients.filter((p) => p._count.appointments > 0).length;

  console.log(`\n═══ НОВЫЕ ПАЦИЕНТЫ: ${newPatients.length} ═══`);
  console.log(`  из них с визитами в базе: ${withVisits}`);
  console.log(`  без единого визита:       ${newPatients.length - withVisits}`);

  /**
   * По дням. Всплеск в один день — это не поток пациентов, а день выгрузки:
   * у карточек без визитов дату первого обращения взять неоткуда, и туда
   * попадает момент импорта.
   */
  const byDay = new Map<string, number>();
  for (const p of newPatients) {
    const key = p.firstSeenAt.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  const days = [...byDay].sort((a, b) => b[1] - a[1]);
  console.log(`\n  дни с наибольшим числом «первых обращений»:`);
  for (const [day, count] of days.slice(0, 5)) {
    const flag = count >= 50 && count > newPatients.length * 0.25 ? "  ← похоже на день загрузки базы" : "";
    console.log(`    ${day}  ${String(count).padStart(4)}${flag}`);
  }

  /**
   * Настоящее число новых пациентов — без дня загрузки базы.
   *
   * Владелец справедливо спросил: «как понять, кого не считать?». Руками —
   * никак, поэтому считаем здесь. День загрузки узнаём по двум признакам
   * сразу: в него пришлась четверть месяца или больше И у этих карточек почти
   * нет визитов. Один признак ошибётся на удачном дне рекламы, два вместе —
   * нет: настоящий поток пациентов приходит с визитами.
   */
  /**
   * Порог в полсотни карточек за день. Без него скрипт объявлял загрузкой базы
   * четыре карточки из шести — на месяце с малым числом новых пациентов любой
   * день выглядит всплеском. Перенос базы — это сотни строк разом.
   */
  const IMPORT_DAY_MIN = 50;
  const suspect = days.find(([day, count]) => {
    if (count < IMPORT_DAY_MIN) return false;
    if (count <= newPatients.length * 0.25) return false;
    const sameDay = newPatients.filter((p) => p.firstSeenAt.toISOString().slice(0, 10) === day);
    const withoutVisits = sameDay.filter((p) => p._count.appointments === 0).length;
    return withoutVisits > sameDay.length * 0.6;
  });

  if (suspect) {
    const [day, count] = suspect;
    const real = newPatients.length - count;
    console.log(`\n  ${day} — это день загрузки базы из YCLIENTS, а не приток пациентов.`);
    console.log(`  В карточках, перенесённых без визитов, дату первого обращения взять неоткуда,`);
    console.log(`  и туда попал день переноса. Такие карточки не новые — они просто старые.`);
    console.log(`\n  НОВЫХ ПАЦИЕНТОВ ЗА МЕСЯЦ БЕЗ ДНЯ ЗАГРУЗКИ: ${real}`);
    console.log(`  Именно это число берите в отчёт за ${label}.`);
  } else {
    console.log(`\n  дня загрузки базы в этом месяце не видно — число новых пациентов можно брать как есть.`);
  }

  // ── Визиты месяца
  const appts = await prisma.appointment.findMany({
    where: { companyId: company.id, deletedAt: null, startAt: { gte: from, lt: to } },
    select: { status: true, isFirstVisit: true, courseId: true, revenue: true, startAt: true },
  });
  const booked = appts.filter((a) => a.status !== "CANCELLED");
  const arrived = appts.filter((a) => a.status === "ARRIVED");
  const firstVisits = arrived.filter((a) => a.isFirstVisit).length;
  const course = arrived.filter((a) => !a.isFirstVisit && a.courseId).length;
  const revenue = arrived.reduce((sum, a) => sum + Number(a.revenue), 0);

  console.log(`\n═══ ВИЗИТЫ МЕСЯЦА (по дате приёма) ═══`);
  console.log(`  всего записей:  ${appts.length}`);
  console.log(`  записались:     ${booked.length}  (все, кроме отменённых)`);
  console.log(`  пришли:         ${arrived.length}  (администратор отметил посещение)`);
  console.log(`  первичные:      ${firstVisits}`);
  console.log(`  курсовые:       ${course}`);
  console.log(`  повторные:      ${arrived.length - firstVisits - course}`);
  console.log(`  выручка:        ${money(revenue)}`);

  /**
   * Без отметки — отдельно прошедшие и отдельно будущие.
   *
   * Первая версия считала прошедшими все неотмеченные и печатала «134 из них
   * уже прошли» на месяц, где половина приёмов ещё не наступила. Такая строка
   * пугает владельца ровно там, где всё в порядке.
   */
  const now = new Date();
  const unmarked = booked.filter((a) => a.status === "CREATED" || a.status === "CONFIRMED");
  const unmarkedPast = unmarked.filter((a) => a.startAt < now).length;
  const upcoming = unmarked.length - unmarkedPast;

  if (unmarked.length > 0) {
    console.log(`\n  без отметки о посещении: ${unmarked.length}`);
    console.log(`    из них ещё не наступили: ${upcoming}  (это нормально)`);
    console.log(`    уже прошли, но не отмечены: ${unmarkedPast}`);
    if (unmarkedPast > 0) {
      console.log(
        `    Пока отметки нет, визит не попадает ни в «пришли», ни в «первичные», ни в выручку.`,
      );
    }
  }

  /**
   * Записи, созданные в этом месяце, — другое множество: человек мог записаться
   * в августе на сентябрь. В §8 «записавшиеся» определены именно так, а отчёт
   * считает по дате приёма. Показываем оба числа, чтобы не спорить вслепую.
   */
  const createdThisMonth = await prisma.appointment.count({
    where: {
      companyId: company.id,
      deletedAt: null,
      createdAt: { gte: from, lt: to },
      status: { not: "CANCELLED" },
    },
  });
  console.log(`\n  строк заведено у нас в этом месяце: ${createdThisMonth}`);
  console.log(`  ВНИМАНИЕ: это дата появления строки в нашей базе, а не дата записи в YCLIENTS.`);
  console.log(`  В месяц выгрузки сюда попадает вся история разом — сравнивать с «записались» нельзя.`);

  // ── Обращения из переписки
  const conversations = await prisma.conversation.count({
    where: { companyId: company.id, startedAt: { gte: from, lt: to } },
  });
  console.log(`\n═══ ОБРАЩЕНИЯ В ПЕРЕПИСКЕ: ${conversations} ═══`);
  console.log(`  Это диалоги, начатые в месяце. С «новыми пациентами» они не связаны:`);
  console.log(`  человек может записаться по телефону или прийти сам, не написав ни слова.`);

  console.log(`\n═══ ЧТО С ЧЕМ СРАВНИВАТЬ ═══`);
  console.log(`  «Новые пациенты» — не обращения и не воронка. Это карточки с датой первого`);
  console.log(`  обращения в месяце, включая выгруженных из YCLIENTS клиентов без визитов.`);
  console.log(`  Разница между ними и «записались» потерей клиентов НЕ является.`);
  console.log(`  Воронку читайте по трём шагам: обращения → записались → пришли.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("не удалось:", e);
  await prisma.$disconnect();
  process.exit(1);
});
