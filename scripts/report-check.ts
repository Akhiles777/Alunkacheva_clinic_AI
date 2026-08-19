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
  const rows = [...remote.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [title, r] of rows) {
    const primary = byPrimary.get(title) ?? 0;
    const comp = byComposition.get(title)?.count ?? 0;
    const lost = r.total - Math.max(primary, comp);
    console.log(
      `  ${title}\n` +
        `      названа ${r.total} (первой ${r.first}) · у нас основной ${primary}, в составе ${comp}` +
        `${lost > 0 ? `  ← ТЕРЯЕМ ${lost}` : ""}`,
    );
  }

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
