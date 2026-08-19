/**
 * Почему в отчёте по услугам у занятой услуги ноль.
 *
 * «Остеопатия, приём Ирины — 0 мин» при тысячах приёмов. Такое бывает, когда
 * визит ссылается не на ту строку справочника: услуга заведена дважды — одну
 * создала клиника руками, вторая приехала из YCLIENTS, — и приёмы держатся за
 * приезжую, а в отчёте видна заведённая. Или наоборот: строка с приёмами
 * выключена, а отчёт показывает только включённые.
 *
 * Скрипт показывает то, чего не видно на экране: у какой строки сколько
 * приёмов, включена ли она, связана ли с YCLIENTS и есть ли у неё двойник.
 *
 * Ничего не меняет.
 *
 *   npx tsx scripts/services-audit.ts
 *   npx tsx scripts/services-audit.ts --days=90
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizeTitle } from "../lib/integrations/yclients/adopt";

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = Number(daysArg?.slice(7) ?? 90);

async function main() {
  const company = await prisma.company.findFirstOrThrow({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000);
  console.log(`клиника: ${company.name}`);
  console.log(`период: последние ${DAYS} дней\n`);

  const services = await prisma.service.findMany({
    where: { companyId: company.id },
    orderBy: { title: "asc" },
    select: {
      id: true,
      title: true,
      isActive: true,
      yclientsServiceId: true,
      rooms: { select: { roomId: true } },
      _count: { select: { primaryForAppointments: true } },
    },
  });

  const inPeriod = await prisma.appointment.groupBy({
    by: ["primaryServiceId"],
    where: {
      companyId: company.id,
      deletedAt: null,
      status: { not: "CANCELLED" },
      startAt: { gte: since },
    },
    _count: { _all: true },
    _sum: { durationMin: true },
  });
  const byId = new Map(inPeriod.map((r) => [r.primaryServiceId, r]));
  const totalInPeriod = inPeriod.reduce((sum, r) => sum + r._count._all, 0);

  console.log("── услуги с приёмами за период ──");
  const withVisits = services
    .filter((s) => (byId.get(s.id)?._count._all ?? 0) > 0)
    .sort((a, b) => (byId.get(b.id)!._sum.durationMin ?? 0) - (byId.get(a.id)!._sum.durationMin ?? 0));
  for (const s of withVisits) {
    const r = byId.get(s.id)!;
    console.log(
      `  ${s.title}: приёмов ${r._count._all}, ${Math.round((r._sum.durationMin ?? 0) / 60)} ч` +
        ` · ${s.yclientsServiceId ? `YCLIENTS ${s.yclientsServiceId}` : "НЕ связана с YCLIENTS"}` +
        `${s.isActive ? "" : " · ВЫКЛЮЧЕНА — в отчёт по услугам не попадает"}` +
        ` · кабинетов ${s.rooms.length}`,
    );
  }
  if (withVisits.length === 0) console.log("  нет");

  const hidden = withVisits.filter((s) => !s.isActive);
  if (hidden.length > 0) {
    console.log(
      `\n  ВНИМАНИЕ: ${hidden.length} услуг с приёмами выключены. Отчёт показывает только\n` +
        "  включённые, поэтому их часы пропадают из разреза целиком.",
    );
  }

  /**
   * Состав визитов: сколько услуг записано у визита.
   *
   * Визит помнил только первую услугу записи, а таблица связи не заполнялась
   * вовсе — вторая услуга терялась целиком. Здесь видно, заполнилась ли она
   * после выгрузки и сколько визитов состоят больше чем из одной услуги.
   */
  const [linked, multi] = await Promise.all([
    prisma.appointment.count({
      where: { companyId: company.id, deletedAt: null, startAt: { gte: since }, services: { some: {} } },
    }),
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM (
        SELECT "appointmentId" FROM appointment_services
        GROUP BY "appointmentId" HAVING count(*) > 1
      ) t
    `,
  ]);
  console.log(
    `\n── состав визитов ──\n` +
      `  визитов с записанным составом услуг: ${linked} из ${totalInPeriod}\n` +
      `  визитов больше чем из одной услуги: ${Number(multi[0]?.n ?? 0)}`,
  );
  if (linked === 0) {
    console.log(
      "  Состав ещё не записан: он появляется при выгрузке. До этого разрез\n" +
        "  считается по основной услуге визита, как раньше.",
    );
  }

  // ── Двойники по названию
  console.log("\n── задвоенные услуги ──");
  const byName = new Map<string, typeof services>();
  for (const s of services) {
    const key = normalizeTitle(s.title);
    byName.set(key, [...(byName.get(key) ?? []), s]);
  }
  const dups = [...byName.values()].filter((rows) => rows.length > 1);
  if (dups.length === 0) console.log("  нет");
  for (const rows of dups) {
    console.log(`  ${rows[0].title}:`);
    for (const s of rows) {
      const r = byId.get(s.id);
      console.log(
        `      ${s.yclientsServiceId ?? "без номера YCLIENTS"} · приёмов за период ${r?._count._all ?? 0}` +
          ` · всего ${s._count.primaryForAppointments}` +
          `${s.isActive ? "" : " · выключена"} · кабинетов ${s.rooms.length}`,
      );
    }
  }

  // ── Приёмы без услуги
  const noService = byId.get(null);
  if (noService) {
    console.log(
      `\n── приёмов без услуги: ${noService._count._all} (${Math.round((noService._sum.durationMin ?? 0) / 60)} ч) ──\n` +
        "  В разрез по услугам они не попадают ни одной строкой.",
    );
  }

  /**
   * Визиты с нулевой длительностью.
   *
   * Ещё одна причина нуля в разрезе: приёмы есть, а занятого времени нет.
   * YCLIENTS присылает длительность сеанса, и если её не проставили, у нас
   * ложится ноль — услуга выглядит незанятой, кабинет тоже.
   */
  const zeroDuration = await prisma.appointment.count({
    where: {
      companyId: company.id,
      deletedAt: null,
      status: { not: "CANCELLED" },
      startAt: { gte: since },
      durationMin: { lte: 0 },
    },
  });
  console.log(`\n── приёмы с нулевой длительностью: ${zeroDuration} из ${totalInPeriod} ──`);
  if (zeroDuration > 0) {
    console.log(
      "  Такие приёмы не занимают времени ни в услуге, ни в кабинете: длительность\n" +
        "  не проставлена в YCLIENTS. Приёмы видны, часы — нет.",
    );
  }

  // ── Знаменатель
  const scheduleRows = await prisma.clinicSchedule.count({ where: { companyId: company.id } });
  console.log(
    `\n── график клиники: ${scheduleRows} строк ──\n` +
      (scheduleRows === 0
        ? "  ПУСТО. Доступное время считается по запасным двенадцати часам в день,\n" +
          "  поэтому все проценты в разрезе занижены. Заполните «Настройки → Клиника»."
        : "  заполнен — доступное время считается по нему"),
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
