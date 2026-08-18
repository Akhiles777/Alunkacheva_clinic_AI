/**
 * Уборка визитов: исчезнувшие из YCLIENTS и задвоенные.
 *
 * Три жалобы клиники — про отменённые записи, которые у нас остались «пришёл»,
 * про дубли и про удвоенную выручку — скорее всего об одном и том же. Записи в
 * YCLIENTS не всегда правятся на месте: перенос или пересоздание даёт новый
 * номер, а старая запись оттуда просто исчезает. Не помечается удалённой — её
 * там больше нет. Выгрузка обновляет только то, что видит, поэтому старая
 * копия остаётся у нас навсегда: со своим статусом, своей выручкой и своим
 * местом в кабинете.
 *
 * Обычная выгрузка теперь сверяет множества и такие визиты отменяет, но делает
 * это только в своём окне — последний месяц плюс догон от курсора. Историю
 * нужно вычистить один раз, и делает это скрипт.
 *
 * Сначала показывает, потом делает: без --apply ничего не меняется.
 * Персональные данные не печатаются — только номера, даты и суммы.
 *
 *   npx tsx scripts/appointments-cleanup.ts
 *   npx tsx scripts/appointments-cleanup.ts --apply
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { getYclientsClient } from "../lib/integrations/yclients/client";
import { apiDate, hasNextPage, monthWindows, PAGE_SIZE } from "../lib/integrations/yclients/paging";
import { HISTORY_YEARS } from "../lib/integrations/yclients/config";
import { cancelVanished, windowIsTrustworthy } from "../lib/integrations/yclients/vanished";
import type { YclientsRecord } from "../lib/integrations/yclients/types";

const APPLY = process.argv.includes("--apply");

async function main() {
  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  console.log(`клиника: ${company.name}`);
  console.log(APPLY ? "режим: ИЗМЕНЯЕМ данные\n" : "режим: только показать (--apply чтобы применить)\n");

  const client = await getYclientsClient(company.id);
  if (!client) {
    console.log("YCLIENTS выключен или не заданы ключи — сверять не с чем.");
    return;
  }

  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear() - HISTORY_YEARS, now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 1));

  let totalVanished = 0;
  let skippedWindows = 0;
  /**
   * Все записи, которые YCLIENTS показал за всю историю.
   *
   * Нужны, чтобы про задвоенный приём сказать правду. Первая версия скрипта
   * считала «обе половины есть в YCLIENTS», если у обеих есть НАШ номер
   * записи, — и советовала чинить в YCLIENTS то, чего там давно нет.
   */
  const remoteIds = new Set<number>();
  /** Окна, которым верить нельзя: по ним вывод о «половина исчезла» неполон. */
  let untrustedAny = false;

  // ── 1. Визиты, которых в YCLIENTS больше нет
  console.log("── визиты, которых в YCLIENTS больше нет ──");
  for (const window of monthWindows(from, to)) {
    const seenIds: number[] = [];
    let page = 1;
    let fetched = 0;
    let totalCount: number | null = null;

    for (;;) {
      const res = await client.getPage<YclientsRecord[]>(
        client.endpoints.records(client.creds.companyId),
        { start_date: apiDate(window.from), end_date: apiDate(window.to), page, count: PAGE_SIZE },
      );
      const dtos = res.data ?? [];
      if (typeof res.totalCount === "number") totalCount = res.totalCount;
      for (const d of dtos) seenIds.push(d.id);
      fetched += dtos.length;
      if (!hasNextPage({ received: dtos.length, pageSize: PAGE_SIZE, fetchedSoFar: fetched, totalCount: res.totalCount, page })) break;
      page += 1;
    }

    const label = apiDate(window.from).slice(0, 7);
    for (const id of seenIds) remoteIds.add(id);
    if (!windowIsTrustworthy({ fetched, totalCount })) {
      untrustedAny = true;
      // Недобранное окно выглядит как массовая отмена. Пропускаем: одна такая
      // ошибка вычистила бы месяц настоящих визитов.
      skippedWindows += 1;
      console.log(`  ${label}: пропущено — получено ${fetched}, обещано ${totalCount ?? "?"}`);
      continue;
    }

    const candidates = await prisma.appointment.findMany({
      where: {
        companyId: company.id,
        deletedAt: null,
        startAt: { gte: window.from, lt: window.to },
        yclientsRecordId: { not: null, notIn: seenIds },
        status: { not: "CANCELLED" },
      },
      select: { yclientsRecordId: true, startAt: true, status: true, revenue: true },
      orderBy: { startAt: "asc" },
    });
    if (candidates.length === 0) continue;

    const money = candidates.reduce((sum, a) => sum + Number(a.revenue), 0);
    const arrived = candidates.filter((a) => a.status === "ARRIVED").length;
    console.log(
      `  ${label}: ${candidates.length} шт (из них «пришёл» ${arrived}), выручки ${money} ₽`,
    );
    for (const a of candidates.slice(0, 5)) {
      console.log(`      запись ${a.yclientsRecordId} · ${a.startAt.toISOString().slice(0, 16)} · ${a.status} · ${Number(a.revenue)} ₽`);
    }
    totalVanished += candidates.length;

    if (APPLY) {
      const done = await cancelVanished(company.id, window, seenIds, { fetched, totalCount });
      console.log(`      отменено: ${done.cancelled}`);
    }
  }
  console.log(`  всего: ${totalVanished}${skippedWindows ? `, окон пропущено: ${skippedWindows}` : ""}\n`);

  // ── 2. Задвоенные визиты: один пациент, один специалист, одно время
  console.log("── задвоенные визиты ──");
  const dups = await prisma.$queryRaw<
    { patientId: string; staffId: string; startAt: Date; ids: string[]; recordIds: (number | null)[] }[]
  >`
    SELECT "patientId", "staffId", "startAt",
           array_agg(id ORDER BY "createdAt") AS ids,
           array_agg("yclientsRecordId" ORDER BY "createdAt") AS "recordIds"
    FROM appointments
    WHERE "companyId" = ${company.id}
      AND "deletedAt" IS NULL
      AND status <> 'CANCELLED'
    GROUP BY "patientId", "staffId", "startAt"
    HAVING count(*) > 1
    ORDER BY "startAt" DESC
  `;
  if (dups.length === 0) {
    console.log("  нет\n");
  } else {
    console.log(`  групп: ${dups.length}`);

    /**
     * Половина задвоения жива, только если её номер ЕСТЬ в YCLIENTS сейчас.
     * Наличие номера у нас ничего не доказывает: у записи, перенесённой в
     * YCLIENTS, старый номер остаётся в нашей базе, а там его уже нет.
     */
    const alive = (id: number | null) => id !== null && remoteIds.has(id);
    let realDup = 0;
    let ghostDup = 0;
    let localDup = 0;

    for (const d of dups) {
      const live = d.recordIds.filter(alive).length;
      const ghosts = d.recordIds.filter((r) => r !== null && !remoteIds.has(r)).length;
      if (live > 1) realDup += 1;
      else if (ghosts > 0) ghostDup += 1;
      else localDup += 1;
    }

    for (const d of dups.slice(0, 10)) {
      const parts = d.recordIds.map((r) =>
        r === null ? "заведена у нас" : alive(r) ? `${r} (есть в YCLIENTS)` : `${r} (в YCLIENTS уже нет)`,
      );
      console.log(`      ${d.startAt.toISOString().slice(0, 16)} · ${parts.join(" + ")}`);
    }

    if (ghostDup > 0) {
      console.log(
        `  ${ghostDup}: одна половина в YCLIENTS уже не существует — запись там перенесли или ` +
          "пересоздали, у нас осталась старая копия. Уборка ниже их снимет.",
      );
    }
    if (realDup > 0) {
      console.log(
        `  ${realDup}: обе половины живы в YCLIENTS — задвоено там, чинить надо там, ` +
          "иначе выгрузка вернёт их обратно (§2).",
      );
    }
    if (localDup > 0) {
      console.log(`  ${localDup}: половина заведена у нас и не доехала в YCLIENTS.`);
    }
    if (untrustedAny) {
      console.log("  внимание: часть окон не добрана, поэтому «уже нет в YCLIENTS» здесь неполно.");
    }
    console.log("");
  }

  // ── 3. Откуда взялись суммы
  console.log("── откуда взялись суммы визитов ──");
  const bySource = await prisma.appointment.groupBy({
    by: ["revenueSource"],
    where: { companyId: company.id, deletedAt: null, status: "ARRIVED" },
    _count: { _all: true },
    _sum: { revenue: true },
  });
  for (const row of bySource) {
    console.log(
      `  ${row.revenueSource}: ${row._count._all} визитов, ${Number(row._sum.revenue ?? 0)} ₽`,
    );
  }
  console.log(
    "  PRICE_LIST — цена подставлена из прайса, потому что в записи её не было.\n" +
      "  FREE — услуга отдана бесплатно, и это факт, а не пробел.",
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
