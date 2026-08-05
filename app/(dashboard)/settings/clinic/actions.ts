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
/**
 * Исключение в расписании: праздник, санитарный день, укороченный день.
 *
 * Живёт в своей таблице ClinicScheduleException, а не в блобе настроек: его
 * читают запись, загрузка кабинетов и отчёты, и запрос по дате должен быть
 * запросом к базе, а не разбором JSON.
 */
export interface ClinicException {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  label: string;
  closed: boolean;
  /** Часы укороченного дня. Для закрытого дня не используются. */
  startMinute: number;
  endMinute: number;
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

  const exceptions = await readExceptions(session.companyId);

  if (row?.value && typeof row.value === "object") {
    const blob = row.value as unknown as ClinicData;
    return { ...blob, exceptions };
  }
  return {
    name: company?.name ?? "Клиника",
    timezone: company?.timezone ?? "Europe/Moscow",
    dayBoundaryMinute: 0,
    schedule: defaultSchedule(),
    exceptions,
  };
}

async function readExceptions(companyId: string): Promise<ClinicException[]> {
  const rows = await prisma.clinicScheduleException.findMany({
    where: { companyId },
    orderBy: { date: "asc" },
    select: { id: true, date: true, isClosed: true, startMinute: true, endMinute: true, label: true },
  });
  return rows.map((r) => ({
    id: r.id,
    date: r.date.toISOString().slice(0, 10),
    label: r.label ?? "",
    closed: r.isClosed,
    startMinute: r.startMinute ?? 9 * 60,
    endMinute: r.endMinute ?? 21 * 60,
  }));
}

export async function saveClinicSettings(data: ClinicData): Promise<{ ok: true }> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  // Границы рабочего дня клиники — по включённым дням (min начало, max конец).
  const enabled = data.schedule.filter((d) => d.enabled);
  const dayStart = enabled.length ? Math.min(...enabled.map((d) => d.startMinute)) : 540;
  const dayEnd = enabled.length ? Math.max(...enabled.map((d) => d.endMinute)) : 1260;

  /**
   * Исключения проверяем до записи: дата обязана быть датой, а укороченный
   * день — иметь непустое окно. Иначе в расписании появится день, который
   * ничего не значит, а свободные окна посчитать будет нельзя.
   */
  const exceptions = data.exceptions
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))
    .map((e) => ({
      date: new Date(`${e.date}T00:00:00.000Z`),
      isClosed: e.closed,
      startMinute: e.closed ? null : e.startMinute,
      endMinute: e.closed ? null : e.endMinute,
      label: e.label.trim() || null,
    }));
  for (const e of exceptions) {
    if (!e.isClosed && (e.startMinute == null || e.endMinute == null || e.endMinute <= e.startMinute)) {
      throw new Error("У короткого дня конец должен быть позже начала");
    }
  }
  // Блоб хранит расписание; исключения — только в своей таблице, чтобы не
  // появилось двух источников правды об одном и том же дне.
  const blob = { ...data, exceptions: [] as ClinicException[] };

  await prisma.$transaction([
    prisma.setting.upsert({
      where: { companyId_key: { companyId: session.companyId, key: "clinic" } },
      update: { value: blob as unknown as object, updatedById: session.userId },
      create: { companyId: session.companyId, key: "clinic", value: blob as unknown as object },
    }),
    prisma.clinicScheduleException.deleteMany({ where: { companyId: session.companyId } }),
    prisma.clinicScheduleException.createMany({
      data: exceptions.map((e) => ({ ...e, companyId: session.companyId })),
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
