/**
 * Подложить в местную песочницу снимок боевых данных ассистента
 * (`scripts/agent-export.ts`): прайс, врачей и их дни, справочник, инструкцию
 * клиники, график, согласие и сводку визитов.
 *
 *   npx tsx scripts/agent-sandbox-seed.ts
 *   npx tsx scripts/agent-snapshot-load.ts data/agent-snapshot.json
 *   AGENT_DRILL=1 npx tsx scripts/agent-drill.ts --sandbox
 *
 * Идёт ПОСЛЕ сида песочницы: сид заводит клинику, постоянных пациенток и
 * специалиста с нерабочим номером, а снимок заменяет то, по чему агент
 * отвечает. Врачей и услуги сопоставляем по имени и названию — у пациенток
 * песочницы визиты к ним, и эти связи должны сохраниться. Чего в снимке нет,
 * в песочнице выключается: агент видит ровно боевой прайс.
 *
 * Сводка визитов превращается в выдуманных пациентов «снимок-N» с визитами в
 * прошлом — пропорционально настоящим числам. По ним агент решает, кто ведёт
 * услугу и какая услуга у клиники основная, — без них песочница отвечала бы
 * по другим правилам, чем боевой агент.
 *
 * Только на местной базе: боевую клинику скрипт не трогает и при её наличии
 * не запускается.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { prisma } from "../lib/db";
import { SANDBOX_YCLIENTS_ID } from "./sandbox-id";

interface Snapshot {
  takenAt: string;
  company: { name: string; timezone: string };
  services: {
    id: string;
    yclientsServiceId: number | null;
    title: string;
    kind: string;
    price: number;
    durationMin: number;
    isCourse: boolean;
    defaultSessions: number | null;
    stalledAfterDays: number | null;
    isActive: boolean;
  }[];
  staff: {
    id: string;
    yclientsStaffId: number | null;
    name: string;
    specialty: string | null;
    workdays: number[];
    isActive: boolean;
    sortOrder: number;
  }[];
  knowledge: {
    topic: string;
    question: string;
    answer: string;
    serviceId: string | null;
    isActive: boolean;
    needsDoctorApproval: boolean;
    approvedAt: string | null;
  }[];
  settings: { key: string; value: unknown }[];
  schedule: { weekday: number; startMinute: number; endMinute: number; validFrom: string; validTo: string | null }[];
  exceptions: { date: string; isClosed: boolean; startMinute: number | null; endMinute: number | null; label: string | null }[];
  consent: { version: string; text: string; policyUrl: string | null } | null;
  specialists: { name: string; staffId: string | null }[];
  visits: { staffId: string; serviceId: string; patients: number; appointments: number }[];
}

/** Имя и название — без регистра, «ё», кавычек и лишних пробелов. */
const key = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/["«»“”']/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Сколько выдуманных пациентов всего: пропорции боевые, объём — разумный. */
const SYNTH_PATIENTS_MAX = 400;
const SYNTH_PHONE = "+7999";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    console.error("Загрузка снимка — только в местную базу (localhost). Остановлено.");
    process.exit(1);
  }
  const live = await prisma.company.findFirst({ where: { yclientsId: { gte: 100 } }, select: { name: true } });
  if (live) {
    console.error(`В базе есть клиника «${live.name}» — похоже на боевую. Остановлено.`);
    process.exit(1);
  }

  const file = process.argv[2] ?? "data/agent-snapshot.json";
  const snap = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
  const company = await prisma.company.findUnique({ where: { yclientsId: SANDBOX_YCLIENTS_ID } });
  if (!company) {
    console.error("Песочницы нет — сначала npx tsx scripts/agent-sandbox-seed.ts");
    process.exit(1);
  }
  const companyId = company.id;
  console.log(`снимок от ${snap.takenAt}: «${snap.company.name}»`);

  /** Врачи: свой по имени — обновляем, нового — заводим, лишнего — выключаем. */
  const localStaff = await prisma.staff.findMany({ where: { companyId }, select: { id: true, name: true } });
  const staffMap = new Map<string, string>();
  const keptStaff = new Set<string>();
  for (const s of snap.staff) {
    const mine = localStaff.find((l) => key(l.name) === key(s.name));
    const data = { name: s.name, specialty: s.specialty, workdays: s.workdays, isActive: s.isActive, sortOrder: s.sortOrder, deletedAt: null };
    const id = mine
      ? (await prisma.staff.update({ where: { id: mine.id }, data })).id
      : (
          await prisma.staff.create({
            data: { companyId, yclientsStaffId: 100_000 + (s.yclientsStaffId ?? staffMap.size + 1), ...data },
          })
        ).id;
    staffMap.set(s.id, id);
    keptStaff.add(id);
  }
  const offStaff = localStaff.filter((l) => !keptStaff.has(l.id));
  if (offStaff.length > 0) {
    await prisma.staff.updateMany({ where: { id: { in: offStaff.map((l) => l.id) } }, data: { isActive: false } });
  }
  console.log(`специалистов ${snap.staff.length} (новых ${snap.staff.length - (localStaff.length - offStaff.length)}, выключено ${offStaff.length})`);

  /** Услуги — так же, по названию. */
  const localServices = await prisma.service.findMany({ where: { companyId }, select: { id: true, title: true } });
  const serviceMap = new Map<string, string>();
  const keptServices = new Set<string>();
  let nextId = 200_000;
  for (const s of snap.services) {
    const mine = localServices.find((l) => key(l.title) === key(s.title) && !keptServices.has(l.id));
    const data = {
      title: s.title,
      kind: s.kind as never,
      price: s.price,
      durationMin: s.durationMin,
      isCourse: s.isCourse,
      defaultSessions: s.defaultSessions,
      stalledAfterDays: s.stalledAfterDays,
      isActive: s.isActive,
    };
    const id = mine
      ? (await prisma.service.update({ where: { id: mine.id }, data })).id
      : (await prisma.service.create({ data: { companyId, yclientsServiceId: nextId++, ...data } })).id;
    serviceMap.set(s.id, id);
    keptServices.add(id);
  }
  const offServices = localServices.filter((l) => !keptServices.has(l.id));
  if (offServices.length > 0) {
    await prisma.service.updateMany({ where: { id: { in: offServices.map((l) => l.id) } }, data: { isActive: false } });
  }
  console.log(`услуг ${snap.services.length} (выключено песочных ${offServices.length})`);

  /** Справочник — целиком боевой. */
  await prisma.knowledgeEntry.deleteMany({ where: { companyId } });
  for (const k of snap.knowledge) {
    await prisma.knowledgeEntry.create({
      data: {
        companyId,
        topic: k.topic,
        question: k.question,
        answer: k.answer,
        serviceId: k.serviceId ? (serviceMap.get(k.serviceId) ?? null) : null,
        isActive: k.isActive,
        needsDoctorApproval: k.needsDoctorApproval,
        approvedAt: k.approvedAt ? new Date(k.approvedAt) : null,
      },
    });
  }
  console.log(`записей справочника ${snap.knowledge.length} (включённых ${snap.knowledge.filter((k) => k.isActive).length})`);

  for (const st of snap.settings) {
    await prisma.setting.upsert({
      where: { companyId_key: { companyId, key: st.key } },
      update: { value: st.value as never },
      create: { companyId, key: st.key, value: st.value as never },
    });
  }
  console.log(`настройки: ${snap.settings.map((s) => s.key).join(", ") || "—"}`);

  await prisma.clinicSchedule.deleteMany({ where: { companyId } });
  for (const r of snap.schedule) {
    await prisma.clinicSchedule.create({
      data: {
        companyId,
        weekday: r.weekday,
        startMinute: r.startMinute,
        endMinute: r.endMinute,
        validFrom: new Date(r.validFrom),
        validTo: r.validTo ? new Date(r.validTo) : null,
      },
    });
  }
  await prisma.clinicScheduleException.deleteMany({ where: { companyId } });
  for (const e of snap.exceptions) {
    await prisma.clinicScheduleException.create({
      data: { companyId, date: new Date(e.date), isClosed: e.isClosed, startMinute: e.startMinute, endMinute: e.endMinute, label: e.label },
    });
  }
  console.log(`график: ${snap.schedule.length} строк, исключений ${snap.exceptions.length}`);

  if (snap.consent) {
    await prisma.consentDocument.updateMany({ where: { companyId }, data: { isActive: false } });
    await prisma.consentDocument.upsert({
      where: { companyId_version: { companyId, version: snap.consent.version } },
      update: { text: snap.consent.text, policyUrl: snap.consent.policyUrl, isActive: true },
      create: { companyId, version: snap.consent.version, text: snap.consent.text, policyUrl: snap.consent.policyUrl, isActive: true },
    });
  }

  /**
   * Специалисты, которым агент пересылает вопросы. Номера — заведомо
   * нерабочие, как у сида: на прогоне отправка и так не идёт, а если кто-то
   * запустит без AGENT_DRILL, письмо не должно уйти живому человеку.
   */
  await prisma.clinicSpecialist.updateMany({ where: { companyId }, data: { isActive: false } });
  for (const [i, sp] of snap.specialists.entries()) {
    const phone = `+7900000000${i + 1}`;
    const staffId = sp.staffId ? (staffMap.get(sp.staffId) ?? null) : null;
    await prisma.clinicSpecialist.upsert({
      where: { companyId_phone: { companyId, phone } },
      update: { name: sp.name, staffId, isActive: true },
      create: { companyId, name: sp.name, staffId, phone, isActive: true },
    });
  }
  console.log(`специалистов для вопросов ${snap.specialists.length} (номера нерабочие)`);

  /** Сводка визитов → выдуманные пациенты «снимок-N» с визитами в прошлом. */
  const old = await prisma.patient.findMany({
    where: { companyId, phones: { some: { phone: { startsWith: SYNTH_PHONE } } } },
    select: { id: true },
  });
  if (old.length > 0) {
    const ids = old.map((p) => p.id);
    await prisma.appointmentService.deleteMany({ where: { appointment: { patientId: { in: ids } } } }).catch(() => undefined);
    await prisma.appointment.deleteMany({ where: { patientId: { in: ids } } });
    await prisma.patientPhone.deleteMany({ where: { patientId: { in: ids } } });
    await prisma.patient.deleteMany({ where: { id: { in: ids } } });
  }
  const total = snap.visits.reduce((n, v) => n + v.patients, 0);
  const scale = total > SYNTH_PATIENTS_MAX ? SYNTH_PATIENTS_MAX / total : 1;
  let made = 0;
  for (const v of snap.visits) {
    const staffId = staffMap.get(v.staffId);
    const serviceId = serviceMap.get(v.serviceId);
    if (!staffId || !serviceId) continue;
    const service = snap.services.find((s) => s.id === v.serviceId);
    const n = Math.max(1, Math.round(v.patients * scale));
    for (let i = 0; i < n; i += 1) {
      made += 1;
      const phone = `${SYNTH_PHONE}${String(made).padStart(7, "0")}`;
      const at = new Date(Date.now() - (30 + ((made * 7) % 300)) * 86_400_000);
      const patient = await prisma.patient.create({
        data: {
          companyId,
          name: `снимок-${made}`,
          firstSeenAt: at,
          phones: { create: { companyId, phone, isPrimary: true } },
        },
      });
      await prisma.appointment.create({
        data: {
          companyId,
          patientId: patient.id,
          staffId,
          primaryServiceId: serviceId,
          startAt: at,
          endAt: new Date(at.getTime() + (service?.durationMin ?? 40) * 60_000),
          createdAtYclients: at,
          updatedAtYclients: at,
          durationMin: service?.durationMin ?? 40,
          status: "ARRIVED",
          services: {
            create: { companyId, serviceId, priceCharged: service?.price ?? 0, durationMin: service?.durationMin ?? 40 },
          },
        },
      });
    }
  }
  console.log(`сводка визитов: ${snap.visits.length} пар врач—услуга → выдуманных пациентов ${made}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
