/**
 * Снимок того, по чему отвечает ассистент, — для проверки на местной песочнице.
 *
 * Запускается на боевом сервере и ТОЛЬКО ЧИТАЕТ базу:
 *
 *   cd /var/www/clinic && npx tsx scripts/agent-export.ts > ~/agent-snapshot.json
 *
 * Зачем: песочница повторяет прайс и справочник клиники по памяти, а
 * подозрение заказчика (9 октября) — что на живых данных ассистент отвечает
 * хуже, чем на прогоне. Проверять надо на тех же записях справочника, той же
 * инструкции и тех же днях приёма, что видит боевой агент.
 *
 * Что уходит в файл — то, что агент и так отправляет модели или показывает
 * пациенту: прайс, врачи и их дни, справочник, инструкция клиники, график,
 * текст согласия. Плюс сводка визитов: кто какую услугу ведёт и сколько РАЗНЫХ
 * пациентов к нему ходило — без единого имени, телефона и идентификатора
 * карточки (по ней агент решает, кто ведёт услугу и какая услуга основная).
 *
 * Чего в файле НЕТ, намеренно (§7): пациентов, переписки, телефонов —
 * включая телефон врача, которому агент пересылает вопросы, — ключей и
 * токенов. Загрузка в песочницу — `scripts/agent-snapshot-load.ts`.
 */
import "dotenv/config";
import { prisma } from "../lib/db";
import { SANDBOX_YCLIENTS_IDS } from "./sandbox-id";

async function main() {
  // `--sandbox` — снимок самой песочницы: только чтобы проверить выгрузку и загрузку локально.
  const ownSandbox = process.argv.includes("--sandbox");
  // `--company=<номер филиала YCLIENTS>` — какую клинику выгружать, если их несколько.
  const asked = Number(process.argv.find((a) => a.startsWith("--company="))?.slice(10) ?? NaN);
  const candidates = await prisma.company.findMany({
    where: ownSandbox ? { yclientsId: SANDBOX_YCLIENTS_IDS[0] } : { NOT: { yclientsId: { in: SANDBOX_YCLIENTS_IDS } } },
    select: { id: true, name: true, timezone: true, yclientsId: true },
  });
  /**
   * Клиник бывает несколько (на боевом сервере нашлось две). Живая — та, где
   * визиты: выгружаем её и называем выбор вслух, чтобы его можно было
   * проверить. Явный `--company=` сильнее догадки.
   */
  const counted = await Promise.all(
    candidates.map(async (c) => ({
      ...c,
      visits: await prisma.appointment.count({ where: { companyId: c.id } }),
      knowledge: await prisma.knowledgeEntry.count({ where: { companyId: c.id } }),
    })),
  );
  for (const c of counted) {
    console.error(`клиника «${c.name}», филиал ${c.yclientsId}: визитов ${c.visits}, записей справочника ${c.knowledge}`);
  }
  const ranked = [...counted].sort((a, b) => b.visits - a.visits);
  const company = Number.isFinite(asked)
    ? counted.find((c) => c.yclientsId === asked)
    : ranked.length === 1 || (ranked.length > 1 && ranked[0].visits > 0 && ranked[1].visits === 0)
      ? ranked[0]
      : undefined;
  if (!company) {
    console.error(
      Number.isFinite(asked)
        ? `клиники с филиалом ${asked} нет — снимок не делаю`
        : "не понять, какая клиника живая, — укажите её: --company=<номер филиала>",
    );
    process.exit(1);
  }
  console.error(`выгружаю «${company.name}» (филиал ${company.yclientsId})`);
  const where = { companyId: company.id };

  const [services, staff, knowledge, settings, schedule, exceptions, consent, specialists] = await Promise.all([
    prisma.service.findMany({
      where,
      select: {
        id: true,
        yclientsServiceId: true,
        title: true,
        kind: true,
        price: true,
        durationMin: true,
        isCourse: true,
        defaultSessions: true,
        stalledAfterDays: true,
        isActive: true,
      },
    }),
    prisma.staff.findMany({
      where: { ...where, deletedAt: null },
      select: { id: true, yclientsStaffId: true, name: true, specialty: true, workdays: true, isActive: true, sortOrder: true },
    }),
    prisma.knowledgeEntry.findMany({
      where,
      select: {
        topic: true,
        question: true,
        answer: true,
        serviceId: true,
        isActive: true,
        needsDoctorApproval: true,
        approvedAt: true,
      },
    }),
    prisma.setting.findMany({ where: { ...where, key: { in: ["assistant", "clinic"] } }, select: { key: true, value: true } }),
    prisma.clinicSchedule.findMany({
      where,
      select: { weekday: true, startMinute: true, endMinute: true, validFrom: true, validTo: true },
    }),
    prisma.clinicScheduleException.findMany({
      where: { ...where, date: { gte: new Date(Date.now() - 86_400_000) } },
      select: { date: true, isClosed: true, startMinute: true, endMinute: true, label: true },
    }),
    prisma.consentDocument.findFirst({
      where: { ...where, isActive: true },
      orderBy: { createdAt: "desc" },
      select: { version: true, text: true, policyUrl: true },
    }),
    // Телефон специалиста в снимок не идёт: локально ставится заведомо нерабочий.
    prisma.clinicSpecialist.findMany({
      where: { ...where, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { name: true, staffId: true },
    }),
  ]);

  /**
   * Кто какую услугу ведёт и к кому сколько РАЗНЫХ людей ходило за год — по
   * этим числам агент решает, кого называть по услуге и какая услуга у клиники
   * основная (`mainKindOf`). Только счётчики, без пациентов.
   */
  const since = new Date(Date.now() - 365 * 86_400_000);
  const pairs = await prisma.appointment.groupBy({
    by: ["staffId", "primaryServiceId", "patientId"],
    where: { ...where, deletedAt: null, status: { not: "CANCELLED" }, startAt: { gte: since } },
    _count: { _all: true },
  });
  const visits = new Map<string, { staffId: string; serviceId: string; patients: number; appointments: number }>();
  for (const p of pairs) {
    if (!p.staffId || !p.primaryServiceId) continue;
    const key = `${p.staffId}|${p.primaryServiceId}`;
    const row = visits.get(key) ?? { staffId: p.staffId, serviceId: p.primaryServiceId, patients: 0, appointments: 0 };
    row.patients += 1;
    row.appointments += p._count._all;
    visits.set(key, row);
  }

  const snapshot = {
    takenAt: new Date().toISOString(),
    company: { name: company.name, timezone: company.timezone },
    services: services.map((s) => ({ ...s, price: Number(s.price) })),
    staff,
    knowledge,
    settings,
    schedule,
    exceptions,
    consent,
    specialists,
    visits: [...visits.values()],
  };
  process.stdout.write(JSON.stringify(snapshot, null, 2));
  console.error(
    `снимок «${company.name}»: услуг ${services.length}, специалистов ${staff.length}, ` +
      `записей справочника ${knowledge.length}, настроек ${settings.length}, сводок визитов ${visits.size}`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
