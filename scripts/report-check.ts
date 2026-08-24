/**
 * Сходятся ли отчёты с тем, что реально лежит в YCLIENTS.
 *
 * Проверять экраны глазами больше нельзя: услуга показывает ноль, и по виду
 * не отличить «её действительно не делали» от «мы потеряли её при разборе».
 * Скрипт читает сырые записи YCLIENTS и сравнивает три вещи:
 *
 *   1. Какие услуги названы в записях и сколько раз — по данным провайдера.
 *   2. Что из этого доехало к нам: основная услуга визита и полный состав.
 *   3. Сходятся ли итоги разрезов между собой — часы, визиты, выручка.
 *
 * Ничего не меняет. Имён и телефонов не печатает (§7).
 *
 *   npx tsx scripts/report-check.ts            — за 30 дней
 *   npx tsx scripts/report-check.ts --days=90
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { getYclientsClient } from "../lib/integrations/yclients/client";
import { apiDate, hasNextPage, monthWindows, PAGE_SIZE } from "../lib/integrations/yclients/paging";
import type { YclientsRecord } from "../lib/integrations/yclients/types";
import { coursePurchasesBetween } from "../lib/server/course-revenue";
import { revenueByService, revenueByStaff } from "../lib/metrics/service-revenue";

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = Number(daysArg?.slice(7) ?? 30);
const hrs = (min: number) => `${Math.floor(min / 60)} ч ${min % 60} мин`;

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

  // ── 1. Что говорит YCLIENTS
  /** Название услуги → сколько раз названа, из них первой. */
  const remote = new Map<string, { total: number; first: number; ids: Set<number> }>();
  /** Номера записей YCLIENTS за период — по ним ищем, чего у нас нет. */
  const remoteIds = new Set<number>();
  /**
   * Приметы каждой записи: по ним объясняем, почему визит не доехал. Список
   * номеров сам по себе ничего не говорит — открывать два десятка записей
   * руками никто не станет.
   */
  const remoteInfo = new Map<
    number,
    {
      staffId: number;
      clientId: number | null;
      phone: string | null;
      services: number;
      minutes: number;
      at: string;
    }
  >();
  let multiService = 0;
  /**
   * Названия услуг по каждой записи — чтобы посчитать их позже.
   *
   * Считать сразу нельзя: сравнивать наш состав со ВСЕМИ записями YCLIENTS
   * бессмысленно. Часть из них мы не держим намеренно — блокировки времени,
   * отменённые визиты, приёмы без клиента. Колонка «ТЕРЯЕМ» из-за этого была
   * красной всегда, а проверка, которая всегда красная, перестаёт читаться.
   */
  const servicesByRecord = new Map<number, string[]>();

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
        if (d.deleted) continue;
        const at = new Date(d.datetime);
        if (at < from || at > now) continue;
        remoteIds.add(d.id);
        remoteInfo.set(d.id, {
          staffId: d.staff_id,
          clientId: d.client?.id ?? null,
          phone: d.client?.phone?.trim() || null,
          services: (d.services ?? []).length,
          minutes: Math.round((d.seance_length ?? 0) / 60),
          at: d.datetime,
        });
        const svc = d.services ?? [];
        if (svc.length > 1) multiService += 1;
        servicesByRecord.set(
          d.id,
          svc.map((s) => s.title?.trim() || `услуга ${s.id}`),
        );
        svc.forEach((s, i) => {
          const key = s.title?.trim() || `услуга ${s.id}`;
          const acc = remote.get(key) ?? { total: 0, first: 0, ids: new Set<number>() };
          acc.total += 1;
          if (i === 0) acc.first += 1;
          acc.ids.add(s.id);
          remote.set(key, acc);
        });
      }
      fetched += dtos.length;
      if (!hasNextPage({ received: dtos.length, pageSize: PAGE_SIZE, fetchedSoFar: fetched, totalCount: res.totalCount, page })) break;
      page += 1;
    }
  }

  /**
   * Считаем УНИКАЛЬНЫЕ номера. Окна выгрузки соседствуют по датам, и запись на
   * стыке приходила дважды: итог получался больше настоящего, а разрыв с нашей
   * базой — страшнее, чем есть.
   */
  const records = remoteIds.size;
  console.log(`── записей в YCLIENTS за период: ${records} ──`);
  console.log(`   из них с несколькими услугами: ${multiService}\n`);

  // ── 2. Что доехало к нам
  const ours = await prisma.appointment.findMany({
    where: { companyId: company.id, deletedAt: null, status: { not: "CANCELLED" }, startAt: { gte: from, lt: now } },
    select: {
      durationMin: true,
      revenue: true,
      status: true,
      primaryService: { select: { title: true } },
      services: { select: { durationMin: true, priceCharged: true, service: { select: { title: true } } } },
    },
  });

  /**
   * Записи YCLIENTS, которых у нас нет вовсе, и те, что у нас отменены.
   *
   * Без этого разрыв «285 записей там, 266 визитов здесь» выглядит одинаково
   * и когда визиты отменены (это нормально), и когда они не доехали (это
   * потеря).
   */
  const known = await prisma.appointment.findMany({
    where: { companyId: company.id, yclientsRecordId: { in: [...remoteIds] } },
    select: { yclientsRecordId: true, status: true, deletedAt: true },
  });
  const knownIds = new Set(known.map((a) => a.yclientsRecordId as number));
  const cancelledHere = known.filter((a) => a.status === "CANCELLED" || a.deletedAt !== null).length;
  const missing = [...remoteIds].filter((id) => !knownIds.has(id));

  /**
   * Записи, состав которых обязан быть у нас: те, что мы держим и не отменили.
   * Всё остальное в сравнении не участвует — оно учтено отдельными строками
   * ниже, с названной причиной.
   */
  const counted = new Set(
    known.filter((a) => a.status !== "CANCELLED" && a.deletedAt === null)
      .map((a) => a.yclientsRecordId as number),
  );
  const expected = new Map<string, number>();
  for (const [id, titles] of servicesByRecord) {
    if (!counted.has(id)) continue;
    for (const t of titles) expected.set(t, (expected.get(t) ?? 0) + 1);
  }

  const byPrimary = new Map<string, number>();
  const byComposition = new Map<string, { count: number; minutes: number }>();
  let visitMinutes = 0;
  let compositionMinutes = 0;
  /** Часы визитов, у которых состав записан: только их и сравниваем. */
  let composedVisitMinutes = 0;
  let withComposition = 0;
  let withoutService = 0;

  for (const a of ours) {
    visitMinutes += a.durationMin;
    const p = a.primaryService?.title;
    if (p) byPrimary.set(p, (byPrimary.get(p) ?? 0) + 1);
    else if (a.services.length === 0) withoutService += 1;

    if (a.services.length > 0) {
      withComposition += 1;
      composedVisitMinutes += a.durationMin;
    }
    for (const s of a.services) {
      const key = s.service.title;
      const acc = byComposition.get(key) ?? { count: 0, minutes: 0 };
      acc.count += 1;
      acc.minutes += s.durationMin;
      byComposition.set(key, acc);
      compositionMinutes += s.durationMin;
    }
  }

  console.log("── услуги: YCLIENTS против нашей базы ──");
  console.log("   названа = сколько раз услуга указана в записях");
  console.log("   первой  = сколько раз она была ПЕРВОЙ (только их видел старый отчёт)\n");
  console.log("   ждём  = сколько раз она названа в записях, которые мы держим\n");
  const rows = [...remote.entries()].sort((a, b) => b[1].total - a[1].total);
  let lostTotal = 0;
  for (const [title, r] of rows) {
    const primary = byPrimary.get(title) ?? 0;
    const comp = byComposition.get(title)?.count ?? 0;
    const want = expected.get(title) ?? 0;
    const lost = want - Math.max(primary, comp);
    if (lost > 0) lostTotal += lost;
    console.log(
      `  ${title}\n` +
        `      названа ${r.total} (первой ${r.first}, ждём ${want}) · у нас основной ${primary}, в составе ${comp}` +
        `${lost > 0 ? `  ← ТЕРЯЕМ ${lost}` : ""}`,
    );
  }
  console.log(
    lostTotal === 0
      ? "\n  ✓ состав визитов совпадает с YCLIENTS по всем услугам"
      : `\n  ✗ всего теряем ${lostTotal} упоминаний услуг — состав визита неполон`,
  );

  // ── 3. Сходятся ли итоги
  console.log("\n── сходятся ли итоги ──");
  console.log(`  записей в YCLIENTS: ${records}`);
  console.log(`  из них у нас есть: ${knownIds.size}` +
    `${cancelledHere > 0 ? ` (отменённых или удалённых у нас: ${cancelledHere})` : ""}`);
  console.log(`  визитов в разрезе (не отменённых): ${ours.length}`);
  if (missing.length > 0) {
    /**
     * Причину называем сразу. Визит пишется, только если нашлись и специалист,
     * и пациент: без клиента и без телефона связать его не с кем, а
     * неизвестный специалист теперь заводится сам — если этого не произошло,
     * дело в другом, и это надо видеть отдельно.
     */
    const staffIds = [...new Set(missing.map((id) => remoteInfo.get(id)?.staffId).filter((x): x is number => typeof x === "number"))];
    const knownStaff = new Set(
      (
        await prisma.staff.findMany({
          where: { companyId: company.id, yclientsStaffId: { in: staffIds } },
          select: { yclientsStaffId: true },
        })
      ).map((r) => r.yclientsStaffId as number),
    );

    const reasons = new Map<string, number[]>();
    for (const id of missing) {
      const info = remoteInfo.get(id);
      /**
       * Разделяем два случая с одной причиной: лечатся они по-разному.
       *
       * Запись без клиента и без услуг — блокировка времени: администратор
       * закрыл окно в расписании. Приёма не было, и в приёмы ей не место, но
       * кабинет она занимает.
       *
       * Запись без клиента, но С услугами — потерянный приём: работа была, а
       * связать её не с кем. Это чинится в YCLIENTS.
       */
      const why = !info
        ? "нет данных о записи"
        : !info.clientId && !info.phone
          ? info.services === 0
            ? "блокировка времени: нет клиента и нет услуг"
            : "ПОТЕРЯННЫЙ ПРИЁМ: услуги есть, клиента нет"
          : !knownStaff.has(info.staffId)
            ? `специалист ${info.staffId} не заведён у нас`
            : "причина не очевидна — нужен разбор";
      reasons.set(why, [...(reasons.get(why) ?? []), id]);
    }

    console.log(`  ✗ НЕ ДОЕХАЛО: ${missing.length} записей — их нет у нас ни в каком виде.`);
    for (const [why, ids] of [...reasons.entries()].sort((a, b) => b[1].length - a[1].length)) {
      /**
       * Есть ли у записи услуги — по этому видно, визит это или блокировка
       * времени. Администратор закрывает окно в расписании записью без
       * клиента: комната занята, но приёма нет. Лечится это по-разному.
       */
      const withServices = ids.filter((id) => (remoteInfo.get(id)?.services ?? 0) > 0).length;
      const minutes = ids.reduce((sum, id) => sum + (remoteInfo.get(id)?.minutes ?? 0), 0);
      console.log(`      ${ids.length} — ${why}`);
      console.log(
        `          из них с услугами ${withServices}, без услуг ${ids.length - withServices}` +
          ` · всего ${Math.round(minutes / 60)} ч`,
      );
      console.log(`          номера: ${ids.slice(0, 10).join(", ")}${ids.length > 10 ? " …" : ""}`);
    }
  } else {
    console.log("  ✓ все записи YCLIENTS есть у нас");
  }

  /**
   * Часы сверяем ТОЛЬКО по визитам, у которых состав услуг записан. Пока
   * состав заполнен не у всех (до полной выгрузки), сравнение всех часов с
   * частью состава показывало бы огромное «расхождение» на ровном месте.
   */
  console.log(`\n  часы визитов всего: ${hrs(visitMinutes)}`);
  if (withComposition === 0) {
    console.log("  состав услуг ещё не записан ни у одного визита — нужна полная выгрузка");
  } else {
    console.log(`  визитов с записанным составом: ${withComposition} из ${ours.length}`);
    console.log(`  их часы: ${hrs(composedVisitMinutes)}, по услугам: ${hrs(compositionMinutes)}`);
    const diff = compositionMinutes - composedVisitMinutes;
    console.log(
      diff === 0
        ? "  ✓ часы сходятся до минуты"
        : `  ✗ РАСХОЖДЕНИЕ ${diff} мин — разрезы покажут разные итоги`,
    );
  }
  if (withoutService > 0) console.log(`  визитов без услуги вовсе: ${withoutService}`);

  /**
   * Остальные разрезы одного и того же периода.
   *
   * Смысл проверки один: числа, которые обязаны совпадать, должны совпадать.
   * Разошлись — значит два экрана покажут разное, и доверия не будет ни
   * одному. Именно так этот проект и обжигался: «205 против 215», «21 против
   * 23», «неявки 0%».
   */
  console.log("\n── остальные разрезы ──");
  const full = await prisma.appointment.findMany({
    where: { companyId: company.id, deletedAt: null, startAt: { gte: from, lt: now } },
    select: {
      status: true,
      isFirstVisit: true,
      revenue: true,
      revenueSource: true,
      courseId: true,
      durationMin: true,
      roomId: true,
      staffId: true,
      sourceId: true,
      primaryServiceId: true,
    },
  });
  const arrived = full.filter((a) => a.status === "ARRIVED");
  const money = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;

  // Первичные и повторные обязаны в сумме давать пришедших (§8).
  const first = arrived.filter((a) => a.isFirstVisit).length;
  const repeat = arrived.length - first;
  console.log(`  пришедшие: ${arrived.length} = первичные ${first} + повторные ${repeat}` +
    `${first + repeat === arrived.length ? "  ✓" : "  ✗"}`);

  /**
   * Состав визита обязан сходиться с его суммой.
   *
   * Разрез по услугам — и в отчётах, и у ИИ-аналитика — считается по составу:
   * у каждой услуги там своя стоимость. Если сумма состава расходится с
   * выручкой визита, разрез по услугам и общий итог покажут разное, и доверия
   * не будет ни одному.
   *
   * Расхождение возможно законно: услуга записи не нашлась в справочнике,
   * тогда её деньги есть в визите и нет в составе. Это надо видеть числом.
   */
  const composed = await prisma.appointment.findMany({
    where: {
      companyId: company.id,
      deletedAt: null,
      status: "ARRIVED",
      startAt: { gte: from, lt: now },
      services: { some: {} },
    },
    select: { revenue: true, services: { select: { priceCharged: true } } },
  });
  let visitMoney = 0;
  let partMoney = 0;
  let mismatched = 0;
  for (const a of composed) {
    const parts = a.services.reduce((s2, x) => s2 + Number(x.priceCharged), 0);
    visitMoney += Number(a.revenue);
    partMoney += parts;
    if (Math.abs(parts - Number(a.revenue)) > 0.005) mismatched += 1;
  }
  console.log(
    `  состав против визита: ${money(partMoney)} против ${money(visitMoney)}` +
      (mismatched === 0
        ? "  ✓"
        : `\n      ✗ у ${mismatched} визитов состав не сходится с суммой — разрез по услугам соврёт`),
  );

  // Выручка по визитам должна совпадать с суммой по специалистам и по услугам.
  const revTotal = arrived.reduce((s2, a) => s2 + Number(a.revenue), 0);
  const byStaff = new Map<string, number>();
  const bySvc = new Map<string | null, number>();
  for (const a of arrived) {
    byStaff.set(a.staffId, (byStaff.get(a.staffId) ?? 0) + Number(a.revenue));
    bySvc.set(a.primaryServiceId, (bySvc.get(a.primaryServiceId) ?? 0) + Number(a.revenue));
  }
  const revStaff = [...byStaff.values()].reduce((s2, v) => s2 + v, 0);
  const revSvc = [...bySvc.values()].reduce((s2, v) => s2 + v, 0);
  console.log(
    `  выручка: визиты ${money(revTotal)} · по специалистам ${money(revStaff)} · по услугам ${money(revSvc)}` +
      `${revTotal === revStaff && revTotal === revSvc ? "  ✓" : "  ✗ РАСХОЖДЕНИЕ"}`,
  );

  /**
   * Разрезы выручки обязаны сходиться между собой И с итогом.
   *
   * Проверка выше сравнивала три числа из одного источника — она не могла
   * поймать настоящее расхождение. А оно было: деньги за курс, у которого ещё
   * нет сеансов, попадали в разрез по услугам и в итог, но ни к какому
   * специалисту. В разрезе по услугам БОС-терапия показывала 218 000 ₽, а у
   * специалиста, которая её ведёт, стояло 180 000 ₽, и объяснить это было
   * нечем.
   *
   * Считаем теми же функциями, что и экраны (§8), и сверяем итоги.
   */
  console.log("\n── разрезы выручки: сходятся ли между собой ──");
  const purchases = await coursePurchasesBetween(company.id, from, now);
  const coursesMoney = purchases.reduce((s2, p) => s2 + p.amount, 0);
  const noStaffMoney = purchases.filter((p) => !p.staffId).reduce((s2, p) => s2 + p.amount, 0);

  const visitsForRevenue = await prisma.appointment.findMany({
    where: { companyId: company.id, deletedAt: null, status: "ARRIVED", startAt: { gte: from, lt: now } },
    select: {
      revenue: true,
      staff: { select: { name: true } },
      primaryService: { select: { title: true } },
      services: { select: { priceCharged: true, service: { select: { title: true } } } },
    },
  });
  const visitRows = visitsForRevenue.map((v) => ({
    status: "arrived",
    doctor: v.staff?.name ?? "специалист не указан",
    price: Number(v.revenue),
    service: v.primaryService?.title ?? "услуга не указана",
    parts: v.services.map((sv) => ({ title: sv.service.title, amount: Number(sv.priceCharged) })),
  }));
  const sales = purchases.map((p) => ({
    serviceTitle: p.serviceTitle,
    staffName: p.staffName,
    amount: p.amount,
  }));

  const total = visitRows.reduce((s2, v) => s2 + v.price, 0) + coursesMoney;
  const svcTotal = revenueByService(visitRows, sales).reduce((s2, r) => s2 + r.revenue, 0);
  const staffTotal = revenueByStaff(visitRows, sales).reduce((s2, r) => s2 + r.revenue, 0);

  console.log(`  итог периода: ${money(total)} (визиты ${money(total - coursesMoney)} + курсы ${money(coursesMoney)})`);
  console.log(
    `  по услугам: ${money(svcTotal)}` +
      (Math.abs(svcTotal - total) < 1 ? "  ✓" : `  ✗ РАСХОЖДЕНИЕ ${money(svcTotal - total)}`),
  );
  console.log(
    `  по специалистам: ${money(staffTotal)} + без специалиста ${money(noStaffMoney)} = ${money(staffTotal + noStaffMoney)}` +
      (Math.abs(staffTotal + noStaffMoney - total) < 1
        ? "  ✓"
        : `  ✗ РАСХОЖДЕНИЕ ${money(staffTotal + noStaffMoney - total)}`),
  );
  if (noStaffMoney > 0) {
    const n = purchases.filter((p) => !p.staffId).length;
    console.log(
      `  ${n} курсов на ${money(noStaffMoney)} без специалиста: сеансов ещё не было, ` +
        "а услугу ведёт не один человек. Экран показывает это отдельной строкой.",
    );
  }

  // Кабинеты: визит либо в кабинете, либо без него — третьего нет.
  const withRoom = full.filter((a) => a.roomId !== null).length;
  const noRoom = full.length - withRoom;
  console.log(
    `  кабинеты: ${withRoom} визитов с кабинетом + ${noRoom} без = ${full.length}` +
      (noRoom > 0 ? `\n      ${noRoom} визитов в загрузку кабинетов не попадают вовсе` : "  ✓"),
  );

  // Источники: без источника визит не виден ни в одной строке разреза.
  const noSource = full.filter((a) => a.sourceId === null).length;
  if (noSource > 0) {
    console.log(`  источники: ${noSource} из ${full.length} визитов без источника — строкой «не указан»`);
  }

  /**
   * Откуда взялась каждая сумма.
   *
   * Главная проверка после отказа от подстановки цен. Обязано выполняться:
   * весь ноль лежит в бесплатных и курсовых, а деньги — только в записях
   * YCLIENTS. Строка PRICE_LIST здесь означает, что полный перечёт не
   * доделан: такие визиты всё ещё показывают выдуманные рубли.
   */
  console.log("\n── откуда суммы визитов ──");
  const srcAcc = new Map<string, { n: number; sum: number }>();
  for (const a of arrived) {
    const acc = srcAcc.get(a.revenueSource) ?? { n: 0, sum: 0 };
    acc.n += 1;
    acc.sum += Number(a.revenue);
    srcAcc.set(a.revenueSource, acc);
  }
  const LABEL: Record<string, string> = {
    RECORD: "стоимость из записи YCLIENTS",
    PREPAID: "сеанс курса — оплачен в день продажи",
    FREE: "подарок, скидка 100%",
    UNKNOWN: "бесплатно: стоимости в записи нет",
    PRICE_LIST: "СТАРОЕ ПРАВИЛО, цена из прайса",
  };
  for (const [src, v] of [...srcAcc.entries()].sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(`  ${src.padEnd(11)} ${String(v.n).padStart(5)} визитов · ${money(v.sum)} — ${LABEL[src] ?? "?"}`);
  }
  const stale = srcAcc.get("PRICE_LIST");
  if (stale) {
    console.log(
      `  ✗ ${stale.n} визитов на ${money(stale.sum)} остались со старым правилом.\n` +
        "      Нужен полный перечёт: npx tsx scripts/yclients-resync.ts --apply",
    );
  }
  const zeroSources = ["PREPAID", "FREE", "UNKNOWN"];
  const leaked = zeroSources.filter((k) => (srcAcc.get(k)?.sum ?? 0) !== 0);
  console.log(
    leaked.length === 0
      ? "  ✓ бесплатные и курсовые визиты выручки не создают"
      : `  ✗ у ${leaked.join(", ")} ненулевая сумма — это выдуманные деньги`,
  );

  const courseSessions = arrived.filter((a) => a.courseId !== null).length;
  const prepaid = srcAcc.get("PREPAID")?.n ?? 0;
  console.log(
    `  сеансов, привязанных к курсу: ${courseSessions} из ${prepaid} курсовых` +
      (prepaid > 0 && courseSessions === 0
        ? "\n      ни одного курса не собрано: продажи нет в кассе либо услуга не отмечена курсовой"
        : ""),
  );

  /**
   * Курс не должен создавать денег.
   *
   * Его сумма — это покупка в кассе, а выручка считается по записям YCLIENTS.
   * Складывать одно с другим нельзя, и проверка стоит здесь, чтобы это
   * нарушение нашлось само, а не в разговоре с клиентом.
   */
  const courseRows = await prisma.course.findMany({
    where: { companyId: company.id },
    select: {
      amount: true,
      sessionsTotal: true,
      sessionsUsed: true,
      purchasedAt: true,
      origin: true,
    },
  });
  if (courseRows.length > 0) {
    /**
     * Выручку дают покупки, а не курсы: деньги приходят в день продажи и не
     * ждут первого сеанса. Оплата курса записью приёма сюда не попадает —
     * её деньги уже посчитаны выручкой того визита.
     */
    const purchases = await prisma.coursePurchase.findMany({
      where: { companyId: company.id, purchasedAt: { gte: from, lt: now } },
      select: { amount: true, isCourse: true, courseId: true },
    });
    const inPeriod = purchases.filter((p) => p.isCourse);
    const sum = inPeriod.reduce((s2, p) => s2 + Number(p.amount), 0);
    const notCourse = purchases.length - inPeriod.length;
    const unlinked = inPeriod.filter((p) => p.courseId === null).length;
    if (notCourse > 0) {
      console.log(`  покупок, не похожих на курс: ${notCourse} — в выручку курсов не идут`);
    }
    if (unlinked > 0) {
      console.log(
        `  покупок без собравшегося курса: ${unlinked} — деньги в выручке есть,\n` +
          "      но услуга и специалист неизвестны, пока пациент не начал ходить",
      );
    }
    const byRecord = courseRows.filter(
      (c) => c.origin !== "YCLIENTS" && c.purchasedAt >= from && c.purchasedAt < now,
    ).length;
    if (byRecord > 0) {
      console.log(
        `  курсов, проведённых оплатой в записи: ${byRecord} — их деньги уже в выручке визитов`,
      );
    }
    console.log(
      `  курсов всего ${courseRows.length}, продано за период ${inPeriod.length} на ${money(sum)}` +
        "\n      это деньги дней покупки: курс пробивают кассой, и его сумма входит" +
        "\n      в выручку того дня наравне со стоимостью приёмов" +
        `\n      выручка периода целиком: ${money(revTotal + sum)}`,
    );
    const oversold = courseRows.filter((c) => Number(c.amount) <= 0);
    if (oversold.length > 0) {
      console.log(`  ✗ ${oversold.length} курсов с нулевой суммой — покупка потерялась`);
    }
    /**
     * Курсы старше окна кассы.
     *
     * Обычный круг выгрузки читает кассу за двести дней и пересобирает курсы
     * только там. Всё, что куплено раньше, живёт с последнего полного перечёта
     * — если таких курсов много, а перечёт был давно, стоит его повторить.
     */
    const windowStart = new Date(now.getTime() - 200 * 24 * 3600 * 1000);
    const older = courseRows.filter((c) => c.purchasedAt < windowStart).length;
    if (older > 0) {
      console.log(
        `  из них ${older} куплены раньше окна кассы (200 дней) — они не пересобираются\n` +
          "      обычной выгрузкой и держатся с последнего полного перечёта",
      );
    }
    const broken = courseRows.filter((c) => c.sessionsUsed > c.sessionsTotal);
    console.log(
      broken.length === 0
        ? "  ✓ сеансов в курсе не больше проданного"
        : `  ✗ у ${broken.length} курсов сеансов больше, чем продано`,
    );
  }

  /**
   * Свежие сеансы курса ещё со стоимостью.
   *
   * В карточке пациента рядом с «курс 5/10» оказались два сеанса той же услуги
   * по 2 800 ₽ — самые последние. Похоже, YCLIENTS обнуляет стоимость сеанса не
   * в момент визита, а при закрытии, и день-другой он выглядит платным.
   *
   * Если так, выручка сегодняшнего дня завышена и выправляется сама через
   * сутки. Это надо не предполагать, а видеть: сравниваем долю нулевых сеансов
   * у свежих визитов и у тех, что старше трёх дней.
   */
  const courseServices = await prisma.service.findMany({
    where: { companyId: company.id, isCourse: true },
    select: { id: true, title: true },
  });
  if (courseServices.length > 0) {
    const ids = courseServices.map((s2) => s2.id);
    const three = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
    const rows = await prisma.appointment.findMany({
      where: {
        companyId: company.id,
        deletedAt: null,
        status: "ARRIVED",
        startAt: { gte: from, lt: now },
        primaryServiceId: { in: ids },
      },
      select: { startAt: true, revenue: true },
    });
    const share = (list: typeof rows) =>
      list.length === 0 ? null : Math.round((list.filter((r) => Number(r.revenue) === 0).length / list.length) * 100);
    const fresh = rows.filter((r) => r.startAt >= three);
    const old = rows.filter((r) => r.startAt < three);
    console.log("\n── сеансы курсовых услуг: доля без стоимости ──");
    console.log(`  свежие (до 3 дней): ${share(fresh) ?? "—"}% из ${fresh.length}`);
    console.log(`  старше трёх дней:   ${share(old) ?? "—"}% из ${old.length}`);
    const f = share(fresh);
    const o = share(old);
    if (f !== null && o !== null && o - f >= 20) {
      console.log(
        "  ! У свежих сеансов стоимость обнуляется позже: YCLIENTS списывает их\n" +
          "    с курса при закрытии, а не в день визита. Выручка последних дней\n" +
          "    завышена и выправится сама — это не ошибка расчёта.",
      );
    }
  }

  console.log(
    `  статусы: ` +
      [...new Map(full.map((a) => [a.status, full.filter((x) => x.status === a.status).length])).entries()]
        .map(([k, v]) => `${k} ${v}`)
        .join(" · "),
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
