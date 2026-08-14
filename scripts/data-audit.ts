/**
 * Полнота данных клиники: что заполнено, а что пусто.
 *
 * Нужен, когда «данные не на своих местах». Общие счётчики этого не
 * показывают: тысяча пациентов без телефонов и тысяча с телефонами выглядят
 * одинаково, пока не посмотришь на поля. Здесь по каждой сущности видно, чего
 * не хватает и сколько таких строк.
 *
 * Персональные данные не печатаются — только количества.
 *
 *   npx tsx scripts/data-audit.ts
 */
import "dotenv/config";
import { prisma } from "../lib/db";

function line(label: string, filled: number, total: number, note = "") {
  const pct = total === 0 ? 0 : Math.round((filled / total) * 100);
  const bad = total > 0 && pct < 100;
  const mark = total === 0 ? "  " : bad ? "⚠ " : "  ";
  console.log(`${mark}${label.padEnd(34)} ${String(filled).padStart(6)} из ${String(total).padEnd(6)} ${String(pct).padStart(3)}%  ${note}`);
}

function head(title: string) {
  console.log(`\n═══ ${title} ═══`);
}

async function main() {
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const companyId = company.id;
  const companies = await prisma.company.count();
  console.log(`клиника: ${company.name} | филиал YCLIENTS: ${company.yclientsId} | всего клиник в базе: ${companies}`);

  head("ПАЦИЕНТЫ");
  const patients = await prisma.patient.count({ where: { companyId, deletedAt: null } });
  line("с именем", await prisma.patient.count({ where: { companyId, deletedAt: null, name: { not: null } } }), patients);
  line(
    "с телефоном",
    await prisma.patient.count({ where: { companyId, deletedAt: null, phones: { some: {} } } }),
    patients,
    "телефон — ключ сопоставления (§4)",
  );
  line(
    "связаны с YCLIENTS",
    await prisma.patient.count({ where: { companyId, deletedAt: null, yclientsId: { not: null } } }),
    patients,
  );
  line(
    "с визитами",
    await prisma.patient.count({ where: { companyId, deletedAt: null, appointments: { some: {} } } }),
    patients,
  );

  head("ВИЗИТЫ");
  const appts = await prisma.appointment.count({ where: { companyId, deletedAt: null } });
  line("с услугой", await prisma.appointment.count({ where: { companyId, deletedAt: null, primaryServiceId: { not: null } } }), appts);
  line(
    "с кабинетом",
    await prisma.appointment.count({ where: { companyId, deletedAt: null, roomId: { not: null } } }),
    appts,
    "без него не считается загрузка кабинетов",
  );
  line("с суммой больше нуля", await prisma.appointment.count({ where: { companyId, deletedAt: null, revenue: { gt: 0 } } }), appts);
  line(
    "разобраны на первичный/повторный",
    await prisma.appointment.count({ where: { companyId, deletedAt: null, visitKind: { not: null } } }),
    appts,
    "только состоявшиеся получают тип",
  );
  const arrived = await prisma.appointment.count({ where: { companyId, deletedAt: null, status: "ARRIVED" } });
  line("состоявшихся (ARRIVED)", arrived, appts, "по ним считаются выручка и первичные");
  line(
    "первичных",
    await prisma.appointment.count({ where: { companyId, deletedAt: null, isFirstVisit: true } }),
    arrived,
    "доля от состоявшихся",
  );

  head("СПРАВОЧНИКИ");
  const services = await prisma.service.count({ where: { companyId } });
  line("услуги: связаны с YCLIENTS", await prisma.service.count({ where: { companyId, yclientsServiceId: { not: null } } }), services);
  line("услуги: с ценой", await prisma.service.count({ where: { companyId, price: { gt: 0 } } }), services);
  const staff = await prisma.staff.count({ where: { companyId } });
  line("специалисты: связаны с YCLIENTS", await prisma.staff.count({ where: { companyId, yclientsStaffId: { not: null } } }), staff);
  line(
    "специалисты: с кабинетом по умолчанию",
    await prisma.staff.count({ where: { companyId, defaultRoomId: { not: null } } }),
    staff,
    "нужен, если кабинетов нет в YCLIENTS",
  );
  const rooms = await prisma.room.count({ where: { companyId } });
  line("кабинеты: связаны с YCLIENTS", await prisma.room.count({ where: { companyId, yclientsResourceId: { not: null } } }), rooms);

  head("ПЕРЕПИСКА");
  const convs = await prisma.conversation.count({ where: { companyId } });
  line("диалоги: привязаны к пациенту", await prisma.conversation.count({ where: { companyId, patientId: { not: null } } }), convs);
  line("диалоги: с согласием на ПДн", await prisma.conversation.count({ where: { companyId, consentGrantedAt: { not: null } } }), convs);
  console.log(`   сообщений всего: ${await prisma.message.count({ where: { companyId } })}`);
  console.log(`   записей справочника: ${await prisma.knowledgeEntry.count({ where: { companyId, isActive: true } })}`);

  head("СИНХРОНИЗАЦИЯ");
  for (const c of await prisma.syncCursor.findMany({ where: { companyId }, orderBy: { entity: "asc" } })) {
    const when = c.lastSyncedAt ? c.lastSyncedAt.toISOString().slice(0, 16).replace("T", " ") : "никогда";
    console.log(`   ${c.entity.padEnd(12)} ${c.status.padEnd(8)} ${when}${c.error ? `  ошибка: ${c.error.slice(0, 80)}` : ""}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("проверка упала:", e);
  await prisma.$disconnect();
  process.exit(1);
});
