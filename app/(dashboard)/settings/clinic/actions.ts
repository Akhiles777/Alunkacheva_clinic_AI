"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";

/**
 * Настройки клиники в БД. Основные поля (название, часовой пояс, границы дня)
 * живут в таблице Company; полный блок (рабочие часы по дням, исключения,
 * граница отчётных суток) — в Setting под ключом «clinic». Сохранение — только
 * с правом EDIT_SETTINGS, с записью в аудит.
 */
export interface ClinicDaySchedule {
  weekday: number; // 1..7 (Пн..Вс)
  enabled: boolean;
  startMinute: number;
  endMinute: number;
}
export interface ClinicException {
  id: string;
  date: string;
  label: string;
  closed: boolean;
}
export interface ClinicData {
  name: string;
  timezone: string;
  dayBoundaryMinute: number;
  schedule: ClinicDaySchedule[];
  exceptions: ClinicException[];
}

function defaultSchedule(): ClinicDaySchedule[] {
  return Array.from({ length: 7 }, (_, i) => ({
    weekday: i + 1,
    enabled: i < 6, // Пн–Сб рабочие
    startMinute: 9 * 60,
    endMinute: 21 * 60,
  }));
}

export async function getClinicSettings(): Promise<ClinicData> {
  const session = await getSession();
  const [company, row] = await Promise.all([
    prisma.company.findUnique({ where: { id: session.companyId } }),
    prisma.setting.findUnique({
      where: { companyId_key: { companyId: session.companyId, key: "clinic" } },
    }),
  ]);

  if (row?.value && typeof row.value === "object") {
    return row.value as unknown as ClinicData;
  }
  return {
    name: company?.name ?? "Клиника",
    timezone: company?.timezone ?? "Europe/Moscow",
    dayBoundaryMinute: 0,
    schedule: defaultSchedule(),
    exceptions: [],
  };
}

export async function saveClinicSettings(data: ClinicData): Promise<{ ok: true }> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  // Границы рабочего дня клиники — по включённым дням (min начало, max конец).
  const enabled = data.schedule.filter((d) => d.enabled);
  const dayStart = enabled.length ? Math.min(...enabled.map((d) => d.startMinute)) : 540;
  const dayEnd = enabled.length ? Math.max(...enabled.map((d) => d.endMinute)) : 1260;

  await prisma.$transaction([
    prisma.setting.upsert({
      where: { companyId_key: { companyId: session.companyId, key: "clinic" } },
      update: { value: data as unknown as object, updatedById: session.userId },
      create: { companyId: session.companyId, key: "clinic", value: data as unknown as object },
    }),
    prisma.company.update({
      where: { id: session.companyId },
      data: {
        name: data.name,
        timezone: data.timezone,
        dayStartMinute: dayStart,
        dayEndMinute: dayEnd,
      },
    }),
  ]);

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "clinic",
  });

  return { ok: true };
}
