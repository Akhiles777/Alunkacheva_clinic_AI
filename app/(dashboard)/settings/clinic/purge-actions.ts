"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";

/**
 * Очистка демонстрационных данных перед запуском.
 *
 * Услуги, кабинеты и источники намеренно нельзя удалить, пока с ними связана
 * история: в работающей клинике это защита от потери выручки и визитов. Но
 * перед передачей клиенту нужно обратное — убрать всё придуманное разом, и
 * поштучно это сделать нельзя именно из-за той же защиты.
 *
 * Что удаляем: визиты, пациенты с телефонами и заметками, демонстрационные
 * специалисты вместе со ставками и выплатами.
 *
 * Что не трогаем: клинику, кабинеты, услуги, источники, учётные записи
 * сотрудников, базу знаний ассистента и переписку — это настройки и реальные
 * диалоги, а не выдуманные данные.
 */
export interface PurgePreview {
  appointments: number;
  patients: number;
  demoStaff: number;
  payouts: number;
}

/** Что именно будет удалено — показываем до подтверждения, а не после. */
export async function previewDemoPurge(): Promise<PurgePreview> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  const companyId = session.companyId;

  const [appointments, patients, demoStaff, payouts] = await Promise.all([
    prisma.appointment.count({ where: { companyId } }),
    prisma.patient.count({ where: { companyId } }),
    prisma.staff.count({ where: { companyId, id: { startsWith: "demo_stf_" } } }),
    prisma.payrollPayout.count({ where: { companyId } }),
  ]);
  return { appointments, patients, demoStaff, payouts };
}

/**
 * Удалить демонстрационные данные. Требует точного слова подтверждения:
 * действие необратимо, и случайное нажатие не должно его запускать.
 */
export async function purgeDemoData(confirmation: string): Promise<PurgePreview> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  if (confirmation.trim().toUpperCase() !== "УДАЛИТЬ") {
    throw new Error("Для подтверждения введите слово УДАЛИТЬ");
  }
  const companyId = session.companyId;
  const before = await previewDemoPurge();

  await prisma.$transaction(async (tx) => {
    // Порядок важен: сначала то, что ссылается на визиты и пациентов.
    await tx.appointmentService.deleteMany({ where: { appointment: { companyId } } });
    await tx.appointment.deleteMany({ where: { companyId } });
    await tx.course.deleteMany({ where: { companyId } });
    await tx.patientNote.deleteMany({ where: { companyId } });
    await tx.patientRelation.deleteMany({ where: { companyId } });
    await tx.patientPhone.deleteMany({ where: { companyId } });
    await tx.patientConsent.deleteMany({ where: { companyId } });
    // Диалоги остаются, но перестают указывать на удалённых пациентов.
    await tx.conversation.updateMany({ where: { companyId }, data: { patientId: null } });
    await tx.patient.deleteMany({ where: { companyId } });

    // Демонстрационные специалисты — вместе со ставками и выплатами.
    const demoStaffIds = (
      await tx.staff.findMany({
        where: { companyId, id: { startsWith: "demo_stf_" } },
        select: { id: true },
      })
    ).map((s) => s.id);
    if (demoStaffIds.length > 0) {
      await tx.payrollPayout.deleteMany({ where: { staffId: { in: demoStaffIds } } });
      await tx.staffRate.deleteMany({ where: { staffId: { in: demoStaffIds } } });
      await tx.staffUser.updateMany({
        where: { staffId: { in: demoStaffIds } },
        data: { staffId: null },
      });
      await tx.staff.deleteMany({ where: { id: { in: demoStaffIds } } });
    }

    // Роллапы считались по удалённым визитам — пересчитывать нечего.
    await tx.dailyFunnelRollup.deleteMany({ where: { companyId } });
    await tx.dailyRevenueRollup.deleteMany({ where: { companyId } });
    await tx.dailyRoomLoadRollup.deleteMany({ where: { companyId } });
    await tx.dailyServiceLoadRollup.deleteMany({ where: { companyId } });
  });

  await writeAudit({
    companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "demo_purge",
    meta: { ...before },
  });

  return before;
}
