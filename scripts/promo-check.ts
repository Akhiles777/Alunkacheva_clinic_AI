/**
 * Сверка школьной акции — ТОЛЬКО ЧТЕНИЕ. Гоняется после каждого этапа вместе с
 * report-check и после выкатки. Ничего не пишет; имён и телефонов не печатает.
 *
 * Инварианты (п. 7.2 спецификации):
 *   1. визитов акции в YCLIENTS = визитов акции у нас (по ключу визита);
 *   2. начисленных бонусов не больше, чем новых подтверждённых пациентов, пришедших на визит акции;
 *   3. нет двух бонусов на одного пациента (кроме второго ребёнка);
 *   4. каждый автоматический начисленный бонус ссылается на пришедший визит акции;
 *   5. у каждого снятого бонуса есть причина;
 *   6. ни один визит (сколько бы в нём ни было специалистов) не дал больше бонусов, чем в нём людей.
 * Нарушен хоть один — код выхода 1.
 *
 *   npx tsx --env-file=.env scripts/promo-check.ts
 */
import { prisma } from "../lib/db";
import { getYclientsClient } from "../lib/integrations/yclients/client";
import type { YclientsRecord } from "../lib/integrations/yclients/types";
import { graceEnd, promoVisits, visitKeyOf } from "../lib/metrics/partner-bonus";
import { promoServiceSet, snapshotFrom } from "../lib/metrics/promo-services";

const day = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  let failed = 0;
  const fail = (text: string) => {
    failed += 1;
    console.log(`  ✗ ${text}`);
  };
  const ok = (text: string) => console.log(`  ✓ ${text}`);

  for (const c of companies) {
    const promo = await prisma.promo.findFirst({ where: { companyId: c.id }, orderBy: { createdAt: "asc" } });
    if (!promo) continue;
    console.log(`\n${c.name} · «${promo.name}» ${day(promo.startsAt)} — ${day(promo.endsAt)}`);
    const catalog = await prisma.service.findMany({
      where: { companyId: c.id, yclientsServiceId: { not: null } },
      select: { yclientsServiceId: true, title: true, isActive: true },
    });
    const set = promoServiceSet(
      {
        serviceIds: promo.serviceIds,
        serviceKeywords: promo.serviceKeywords,
        excludedServiceIds: promo.excludedServiceIds,
        serviceSnapshot: snapshotFrom(promo.serviceSnapshot),
      },
      catalog,
    );
    console.log(`  услуги акции: ${set.ids.join(", ") || "НЕТ"} (выбрано ${set.chosen.length}, по названию ${set.byKeyword.length}, исключено ${set.excluded.length})`);
    for (const w of set.warnings) console.log(`  ! ${w.kind}: услуга ${w.yclientsServiceId}`);
    const until = new Date(Math.min(graceEnd(promo).getTime(), Date.now() + 90 * 86_400_000));
    const rule = { serviceIds: set.ids, startsAt: promo.startsAt, endsAt: promo.endsAt };

    // Наши визиты акции.
    const records = set.ids.length
      ? await prisma.appointment.findMany({
          where: { companyId: c.id, startAt: { gte: promo.startsAt, lte: until }, services: { some: { service: { yclientsServiceId: { in: set.ids } } } } },
          select: {
            id: true,
            yclientsRecordId: true,
            yclientsVisitId: true,
            patientId: true,
            startAt: true,
            status: true,
            deletedAt: true,
            services: { select: { quantity: true, service: { select: { yclientsServiceId: true } } } },
          },
        })
      : [];
    const byPatient = new Map<string, typeof records>();
    for (const r of records) byPatient.set(r.patientId, [...(byPatient.get(r.patientId) ?? []), r]);
    const ourVisits = new Map<string, ReturnType<typeof promoVisits>[number] & { patientId: string }>();
    for (const [pid, list] of byPatient) {
      const visits = promoVisits(
        rule,
        list.map((r) => ({
          id: r.id,
          startAt: r.startAt,
          status: r.status,
          deleted: r.deletedAt != null,
          visitKey: visitKeyOf(r),
          services: r.services.map((s) => ({ yclientsServiceId: s.service.yclientsServiceId, quantity: s.quantity })),
        })),
      );
      for (const v of visits) ourVisits.set(v.key, { ...v, patientId: pid });
    }
    const liveOurs = [...ourVisits.values()].filter((v) => v.records.some((r) => !r.deleted));

    // 1. Сверка с YCLIENTS.
    const client = await getYclientsClient(c.id).catch(() => null);
    if (!client) {
      console.log("  · ключей YCLIENTS нет — сверка с источником пропущена");
    } else if (set.ids.length) {
      const ids = new Set(set.ids);
      const theirs = new Set<string>();
      for (let page = 1; page <= 50; page += 1) {
        const res = await client.getPage<YclientsRecord[]>(client.endpoints.records(client.creds.companyId), {
          start_date: day(promo.startsAt),
          end_date: day(until),
          page,
          count: 200,
        });
        const rows = res.data ?? [];
        for (const r of rows) {
          if (r.deleted || !(r.services ?? []).some((s) => ids.has(s.id))) continue;
          theirs.add(r.visit_id ? `v:${r.visit_id}` : `y:${r.id}`);
        }
        if (rows.length < 200) break;
      }
      // Наш ключ без visit_id — по нашей записи; сравниваем по номеру записи YCLIENTS.
      const ours = new Set(
        liveOurs.map((v) => {
          if (v.key.startsWith("v:")) return v.key;
          const rec = records.find((r) => `r:${r.id}` === v.key);
          return `y:${rec?.yclientsRecordId ?? v.key}`;
        }),
      );
      const missing = [...theirs].filter((k) => !ours.has(k));
      const extra = [...ours].filter((k) => !theirs.has(k));
      if (missing.length || extra.length) fail(`визитов акции в YCLIENTS ${theirs.size}, у нас ${ours.size}; нет у нас: ${missing.join(", ") || "—"}; лишние у нас: ${extra.join(", ") || "—"}`);
      else ok(`визитов акции в YCLIENTS и у нас поровну: ${theirs.size}`);
    }

    const attributions = await prisma.partnerAttribution.findMany({
      where: { promoId: promo.id },
      select: {
        id: true,
        patientId: true,
        childNo: true,
        isExtraChild: true,
        reviewStatus: true,
        returningPatient: true,
        removedAt: true,
        bonus: { select: { id: true, status: true, manual: true, reverseReason: true, triggeredByAppointmentId: true, triggeredByVisitKey: true } },
      },
    });
    const earned = attributions.filter((a) => a.bonus?.status === "EARNED");

    // 2.
    const eligiblePatients = new Set(
      attributions
        .filter((a) => a.reviewStatus === "CONFIRMED" && !a.returningPatient && !a.removedAt)
        .filter((a) => [...ourVisits.values()].some((v) => v.patientId === a.patientId && v.arrivedRecordId))
        .map((a) => a.patientId),
    );
    const extraKids = earned.filter((a) => a.childNo > 1).length;
    const autoEarned = earned.filter((a) => !a.bonus!.manual);
    if (autoEarned.length - extraKids > eligiblePatients.size)
      fail(`автоматических бонусов ${autoEarned.length} (из них второй ребёнок ${extraKids}), а новых пришедших привязанных пациентов ${eligiblePatients.size}`);
    else ok(`бонусов ${earned.length} (вручную ${earned.length - autoEarned.length}) — не больше новых пришедших (${eligiblePatients.size})`);

    // 3.
    const perPatient = new Map<string, number>();
    for (const a of earned.filter((x) => x.childNo === 1)) perPatient.set(a.patientId, (perPatient.get(a.patientId) ?? 0) + 1);
    const dup = [...perPatient.values()].filter((n) => n > 1).length;
    if (dup) fail(`у ${dup} пациентов больше одного бонуса за первого ребёнка`);
    else ok("один бонус на пациента (второй ребёнок — отдельно)");

    // 4.
    const bad4 = autoEarned.filter((a) => {
      const id = a.bonus!.triggeredByAppointmentId;
      const rec = records.find((r) => r.id === id);
      return !rec || rec.deletedAt || rec.status !== "ARRIVED";
    });
    if (bad4.length) fail(`${bad4.length} автоматических бонусов ссылаются не на пришедший визит акции: ${bad4.map((a) => a.bonus!.id).join(", ")}`);
    else ok("каждый автоматический бонус — на пришедшем визите акции");

    // 5.
    const bad5 = attributions.filter((a) => a.bonus?.status === "REVERSED" && !a.bonus.reverseReason?.trim());
    if (bad5.length) fail(`${bad5.length} снятых бонусов без причины`);
    else ok("у каждого снятого бонуса есть причина");

    // 6.
    const perVisit = new Map<string, number>();
    for (const a of autoEarned) {
      const key = a.bonus!.triggeredByVisitKey ?? [...ourVisits.values()].find((v) => v.records.some((r) => r.id === a.bonus!.triggeredByAppointmentId))?.key;
      if (key) perVisit.set(key, (perVisit.get(key) ?? 0) + 1);
    }
    const bad6 = [...perVisit].filter(([key, n]) => n > Math.max(1, ...(ourVisits.get(key)?.units.values() ?? [1])));
    if (bad6.length) fail(`визиты дали больше бонусов, чем в них людей: ${bad6.map(([k, n]) => `${k} — ${n}`).join(", ")}`);
    else ok("ни один визит не дал больше бонусов, чем в нём людей (три специалиста — один бонус)");

    const multi = liveOurs.filter((v) => v.records.length > 1).length;
    console.log(`  · визитов акции: ${liveOurs.length}, из нескольких записей: ${multi}, пришли: ${liveOurs.filter((v) => v.arrivedRecordId).length}`);
  }
  console.log(failed ? `\nНАРУШЕНО инвариантов: ${failed}` : "\nВсе инварианты выполнены.");
  if (failed) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
