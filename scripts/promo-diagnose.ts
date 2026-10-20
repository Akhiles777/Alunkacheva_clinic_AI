/**
 * Диагностика перед школьной акцией «Школьный ресурс 6+» — ТОЛЬКО ЧТЕНИЕ.
 *
 * Ничего не пишет ни в базу, ни в YCLIENTS. Персональных данных не печатает:
 * клиент — номером YCLIENTS, пациент — хвостом номера карточки; имён и
 * телефонов нет.
 *
 * 0.1 Как YCLIENTS отдаёт визит с несколькими специалистами: сырой ответ API
 *     за день, во что он превратился у нас (строки Appointment, кабинеты,
 *     деньги, первичный/повторный) и сколько таких визитов в истории.
 * 0.2 Уведомления YCLIENTS с номера клиники («Вы записаны на услугу…»,
 *     «Отменена запись…»): сколько их легло репликой сотрудника, сколько раз
 *     они оставили пациента без ответа агента и попали в «первый ответ человека».
 *
 *   npx tsx --env-file=.env scripts/promo-diagnose.ts [--date=2026-10-21] [--time=10:30] [--days=60]
 */
import { prisma } from "../lib/db";
import { getYclientsClient } from "../lib/integrations/yclients/client";
import type { YclientsRecord } from "../lib/integrations/yclients/types";

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const DATE = arg("date", "2026-10-21");
const TIME = arg("time", "10:30");
const DAYS = Number(arg("days", "60"));

/** Шаблоны уведомлений YCLIENTS — по началу текста. */
const NOTICE =
  /^\s*(?:вы\s+записаны\s+на\s+услугу|отменена\s+запись|ваша\s+запись|напоминаем[,\s]|запись\s+(?:перенесена|изменена)|вы\s+записаны\s+к)/iu;

const money = (d: unknown) => Number(String(d ?? 0));

async function part01(companyId: string) {
  console.log(`\n═══ 0.1 ВИЗИТ ${DATE} ${TIME}: СЫРОЙ ОТВЕТ YCLIENTS ═══`);
  const client = await getYclientsClient(companyId);
  if (!client) {
    console.log("  ключи YCLIENTS не заданы — сырой ответ получить нечем");
    return;
  }
  const all: YclientsRecord[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const res = await client.getPage<YclientsRecord[]>(client.endpoints.records(client.creds.companyId), {
      start_date: DATE,
      end_date: DATE,
      page,
      count: 200,
    });
    const rows = res.data ?? [];
    all.push(...rows);
    if (rows.length < 200) break;
  }
  const promoTitle = /школьн|ресурс|check|чек-?ап/iu;
  const picked = all.filter(
    (r) => r.datetime?.slice(11, 16) === TIME || (r.services ?? []).some((s) => promoTitle.test(s.title ?? "")),
  );
  console.log(`  записей за день: ${all.length}; в ${TIME} или с услугой акции: ${picked.length}`);
  for (const r of picked) {
    console.log(
      `\n  запись ${r.id} · visit_id ${r.visit_id ?? "—"} · ${r.datetime} · ${Math.round((r.seance_length ?? 0) / 60)} мин` +
        ` · специалист ${r.staff_id} ${r.staff?.name ?? ""} · клиент №${r.client?.id ?? "—"}` +
        ` · посещение ${r.visit_attendance ?? "—"} · удалена ${r.deleted ? "да" : "нет"}` +
        ` · ресурсы ${(r.resource_instances ?? []).map((x) => x.resource_id).join(",") || "—"}` +
        ` · оплата ${String(r.payment_status ?? r.paid_full ?? "—")}`,
    );
    for (const s of r.services ?? []) {
      console.log(
        `      услуга ${s.id} «${s.title ?? ""}»: cost ${s.cost ?? "—"}, first_cost ${s.first_cost ?? "—"}, ` +
          `discount ${s.discount ?? "—"}, amount ${s.amount ?? "—"}, cost_to_pay ${s.cost_to_pay ?? "—"}`,
      );
    }
  }
  const visits = new Map<number, YclientsRecord[]>();
  for (const r of picked) if (r.visit_id) visits.set(r.visit_id, [...(visits.get(r.visit_id) ?? []), r]);
  for (const [vid, rows] of visits) {
    if (rows.length > 1) {
      const sum = rows.flatMap((r) => r.services ?? []).reduce((a, s) => a + (s.cost ?? 0), 0);
      console.log(`\n  ► visit_id ${vid}: ${rows.length} записи одного визита, сумма cost по ним ${sum} ₽`);
    }
  }

  console.log(`\n═══ 0.1 ТО ЖЕ У НАС В ПРОЕКЦИИ ═══`);
  const ids = picked.map((r) => r.id);
  const vids = [...visits.keys()];
  const appts = await prisma.appointment.findMany({
    where: {
      companyId,
      OR: [{ yclientsRecordId: { in: ids } }, ...(vids.length ? [{ yclientsVisitId: { in: vids } }] : [])],
    },
    orderBy: { startAt: "asc" },
    select: {
      id: true,
      yclientsRecordId: true,
      yclientsVisitId: true,
      patientId: true,
      startAt: true,
      durationMin: true,
      status: true,
      revenue: true,
      revenueSource: true,
      visitKind: true,
      deletedAt: true,
      staff: { select: { name: true } },
      room: { select: { name: true } },
      services: {
        select: {
          quantity: true,
          priceCharged: true,
          durationMin: true,
          service: { select: { title: true, yclientsServiceId: true } },
        },
      },
    },
  });
  if (appts.length === 0) console.log("  строк нет — запись ещё не выгружена или выгрузка её пропустила");
  for (const a of appts) {
    console.log(
      `  Appointment ${a.id} · запись ${a.yclientsRecordId} · visit ${a.yclientsVisitId ?? "—"} · пациент …${a.patientId.slice(-6)}` +
        ` · ${a.staff.name} · кабинет ${a.room?.name ?? "—"} · ${a.startAt.toISOString()} ${a.durationMin} мин` +
        ` · ${a.status} · выручка ${money(a.revenue)} (${a.revenueSource}) · вид ${a.visitKind ?? "—"}` +
        (a.deletedAt ? " · УДАЛЕНА" : ""),
    );
    for (const s of a.services) {
      console.log(
        `      «${s.service.title}» (${s.service.yclientsServiceId}) ×${s.quantity}: ${money(s.priceCharged)} ₽, ${s.durationMin} мин`,
      );
    }
  }
  if (appts.length > 1) {
    const total = appts.filter((a) => !a.deletedAt).reduce((sum, a) => sum + money(a.revenue), 0);
    console.log(`  ► итого выручка этих строк: ${total} ₽ (у визита в YCLIENTS — сумма cost выше)`);
    console.log(`  ► кабинеты строк: ${appts.map((a) => a.room?.name ?? "—").join(", ")}`);
  }

  console.log(`\n═══ 0.1 СКОЛЬКО ТАКИХ ВИЗИТОВ В ИСТОРИИ (${DAYS} дн.) ═══`);
  const since = new Date(Date.now() - DAYS * 86_400_000);
  const groups = await prisma.appointment.groupBy({
    by: ["yclientsVisitId"],
    where: { companyId, deletedAt: null, yclientsVisitId: { not: null }, startAt: { gte: since } },
    _count: { _all: true },
    having: { yclientsVisitId: { _count: { gt: 1 } } },
  });
  console.log(`  визитов из нескольких записей: ${groups.length}`);
  if (groups.length) {
    const rows = await prisma.appointment.findMany({
      where: { companyId, deletedAt: null, yclientsVisitId: { in: groups.map((g) => g.yclientsVisitId!) } },
      select: { yclientsVisitId: true, status: true, revenue: true, visitKind: true },
    });
    const byVisit = new Map<number, typeof rows>();
    for (const r of rows) byVisit.set(r.yclientsVisitId!, [...(byVisit.get(r.yclientsVisitId!) ?? []), r]);
    let arrivedMulti = 0;
    let paidMulti = 0;
    let firstPlusReturn = 0;
    for (const list of byVisit.values()) {
      if (list.filter((r) => r.status === "ARRIVED").length > 1) arrivedMulti += 1;
      if (list.filter((r) => money(r.revenue) > 0).length > 1) paidMulti += 1;
      const kinds = list.map((r) => r.visitKind);
      if (kinds.includes("FIRST") && kinds.some((k) => k === "RETURN" || k === "COURSE_SESSION")) firstPlusReturn += 1;
    }
    console.log(`  из них «пришли» в нескольких записях: ${arrivedMulti} (каждая запись считается отдельным приходом)`);
    console.log(`  с деньгами в нескольких записях: ${paidMulti}`);
    console.log(`  первичный + повторный внутри ОДНОГО визита: ${firstPlusReturn}`);
  }

  const promoServices = await prisma.service.findMany({
    where: { companyId, title: { contains: "ресурс", mode: "insensitive" } },
    select: { title: true, yclientsServiceId: true, price: true, isActive: true },
  });
  console.log(`\n  услуги со словом «ресурс» в справочнике: ${promoServices.length}`);
  for (const s of promoServices) {
    console.log(`    «${s.title}» · YCLIENTS ${s.yclientsServiceId} · ${money(s.price)} ₽ · ${s.isActive ? "активна" : "выключена"}`);
  }
}

async function part02(companyId: string) {
  console.log(`\n═══ 0.2 УВЕДОМЛЕНИЯ YCLIENTS В WHATSAPP (${DAYS} дн.) ═══`);
  const since = new Date(Date.now() - DAYS * 86_400_000);
  const phoneSent = await prisma.message.findMany({
    where: {
      companyId,
      channel: "WHATSAPP",
      direction: "OUT",
      authorType: "STAFF",
      authorId: null,
      createdAt: { gte: since },
      deletedAt: null,
      conversation: { isPractice: false },
    },
    select: { id: true, conversationId: true, body: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const notices = phoneSent.filter((m) => NOTICE.test(m.body));
  console.log(`  реплик «сотрудника» с телефона: ${phoneSent.length}; из них по шаблону уведомления YCLIENTS: ${notices.length}`);

  // Начала текстов — чтобы увидеть шаблоны, которых нет в списке. Слова с заглавной (имена) и цифры скрыты.
  const prefixes = new Map<string, number>();
  for (const m of phoneSent) {
    const p = m.body.slice(0, 32).replace(/(?<=\s)\p{Lu}\p{Ll}+/gu, "«Имя»").replace(/\d/g, "#");
    prefixes.set(p, (prefixes.get(p) ?? 0) + 1);
  }
  console.log(`  частые начала реплик с телефона (повторяется 3+ раз — кандидат в шаблон):`);
  for (const [p, n] of [...prefixes].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(n).padStart(4)}  ${p}…`);
  }

  const convIds = [...new Set(notices.map((n) => n.conversationId))];
  const around = convIds.length
    ? await prisma.message.findMany({
        where: { conversationId: { in: convIds }, deletedAt: null, createdAt: { gte: new Date(since.getTime() - 86_400_000) } },
        select: { conversationId: true, direction: true, authorType: true, body: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      })
    : [];
  let silenced = 0;
  let asFirstResponse = 0;
  for (const n of notices) {
    const conv = around.filter((m) => m.conversationId === n.conversationId);
    // Пациент написал в первые 4 часа после уведомления, а живого ответа сотрудника между ними не было.
    const nextIn = conv.find(
      (m) => m.direction === "IN" && m.createdAt > n.createdAt && m.createdAt.getTime() - n.createdAt.getTime() < 4 * 3_600_000,
    );
    if (nextIn) {
      const realStaff = conv.some(
        (m) => m.authorType === "STAFF" && !NOTICE.test(m.body) && m.createdAt > n.createdAt && m.createdAt <= nextIn.createdAt,
      );
      if (!realStaff) silenced += 1;
    }
    // Уведомление — первый исходящий после вопроса пациента: метрика засчитала бы его ответом человека.
    const prev = [...conv].reverse().find((m) => m.createdAt < n.createdAt);
    if (prev && prev.direction === "IN") asFirstResponse += 1;
  }
  console.log(`  пациент писал в первые 4 часа после уведомления, а агент молчал из-за него: ${silenced}`);
  console.log(`  уведомление было первым исходящим после вопроса пациента («первый ответ человека»): ${asFirstResponse}`);
}

async function main() {
  // Боевая клиника привязана к филиалу YCLIENTS; местная песочница — нет, тогда первая по времени.
  const company =
    (await prisma.company.findFirst({
      where: { yclientsId: { gte: 100 } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    })) ?? (await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" }, select: { id: true, name: true } }));
  console.log(`клиника: ${company.name}`);
  await part01(company.id).catch((e) => console.log(`  0.1 не удалось: ${(e as Error).message}`));
  await part02(company.id).catch((e) => console.log(`  0.2 не удалось: ${(e as Error).message}`));
}

main().finally(() => prisma.$disconnect());
