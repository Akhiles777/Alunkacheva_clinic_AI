import { prisma } from "@/lib/db";
import { getYclientsClient, type YclientsClientHandle } from "./client";
import { markFailed, markOk, markRunning } from "./sync-cursor";
import {
  mapClient,
  mapRecord,
  mapResource,
  mapService,
  mapStaff,
} from "./mappers";
import type {
  YclientsClient,
  YclientsRecord,
  YclientsResource,
  YclientsService,
  YclientsStaff,
} from "./types";

/**
 * Оркестрация синхронизации YCLIENTS → локальная проекция (§2, §5). Идемпотентно
 * по yclients*Id: повторный прогон и повторный вебхук не создают дублей.
 *
 * Пока интеграция выключена, getYclientsClient вернёт null и все функции просто
 * вернут { skipped: true } — ни одного сетевого вызова.
 *
 * Начальная выгрузка обязательна перед запуском (§5) — это syncAll с пустыми
 * курсорами. Догоны двигают SyncCursor.
 */
export interface SyncResult {
  skipped: boolean;
  counts: Partial<Record<"services" | "staff" | "resources" | "clients" | "records", number>>;
  errors: string[];
}

export async function syncAll(companyId: string): Promise<SyncResult> {
  const client = await getYclientsClient(companyId);
  if (!client) return { skipped: true, counts: {}, errors: [] };

  const counts: SyncResult["counts"] = {};
  const errors: string[] = [];

  // Справочники — до записей: записи ссылаются на услуги/персонал/кабинеты.
  counts.services = await run("SERVICES", () => syncServices(companyId, client), errors, companyId);
  counts.staff = await run("STAFF", () => syncStaff(companyId, client), errors, companyId);
  counts.resources = await run("RESOURCES", () => syncResources(companyId, client), errors, companyId);
  counts.clients = await run("CLIENTS", () => syncClients(companyId, client), errors, companyId);
  counts.records = await run("RECORDS", () => syncRecords(companyId, client), errors, companyId);

  return { skipped: false, counts, errors };
}

async function run(
  entity: "SERVICES" | "STAFF" | "RESOURCES" | "CLIENTS" | "RECORDS",
  fn: () => Promise<number>,
  errors: string[],
  companyId: string,
): Promise<number> {
  await markRunning(companyId, entity);
  try {
    const n = await fn();
    await markOk(companyId, entity);
    return n;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`${entity}: ${msg}`);
    await markFailed(companyId, entity, msg);
    return 0;
  }
}

export async function syncServices(companyId: string, client: YclientsClientHandle): Promise<number> {
  const dtos = await client.get<YclientsService[]>(client.endpoints.services(client.creds.companyId));
  for (const dto of dtos) {
    const s = mapService(dto);
    await prisma.service.upsert({
      where: { companyId_yclientsServiceId: { companyId, yclientsServiceId: s.yclientsServiceId } },
      update: { title: s.title, price: s.price, durationMin: s.durationMin, kind: s.kind, isActive: s.isActive },
      create: { companyId, ...s },
    });
  }
  return dtos.length;
}

export async function syncStaff(companyId: string, client: YclientsClientHandle): Promise<number> {
  const dtos = await client.get<YclientsStaff[]>(client.endpoints.staff(client.creds.companyId));
  for (const dto of dtos) {
    const s = mapStaff(dto);
    await prisma.staff.upsert({
      where: { companyId_yclientsStaffId: { companyId, yclientsStaffId: s.yclientsStaffId } },
      update: { name: s.name, specialty: s.specialty, isActive: s.isActive },
      create: { companyId, ...s },
    });
  }
  return dtos.length;
}

export async function syncResources(companyId: string, client: YclientsClientHandle): Promise<number> {
  const dtos = await client.get<YclientsResource[]>(client.endpoints.resources(client.creds.companyId));
  for (const dto of dtos) {
    const r = mapResource(dto);
    await prisma.room.upsert({
      where: { companyId_yclientsResourceId: { companyId, yclientsResourceId: r.yclientsResourceId } },
      update: { name: r.name },
      create: { companyId, ...r },
    });
  }
  return dtos.length;
}

export async function syncClients(companyId: string, client: YclientsClientHandle): Promise<number> {
  const dtos = await client.get<YclientsClient[]>(client.endpoints.clients(client.creds.companyId));
  for (const dto of dtos) {
    const c = mapClient(dto);
    // yclientsId — nullable-unique: findFirst + create/update вместо upsert.
    const found = await prisma.patient.findFirst({
      where: { companyId, yclientsId: c.yclientsId },
      select: { id: true },
    });
    const patient = found
      ? await prisma.patient.update({ where: { id: found.id }, data: { name: c.name } })
      : await prisma.patient.create({
          data: { companyId, yclientsId: c.yclientsId, name: c.name, firstSeenAt: new Date() },
        });
    // Телефон — по нормализованному E.164, без дублей.
    if (c.phoneE164) {
      const exists = await prisma.patientPhone.findFirst({
        where: { companyId, patientId: patient.id, phone: c.phoneE164 },
        select: { id: true },
      });
      if (!exists) {
        const hasPrimary = await prisma.patientPhone.count({ where: { patientId: patient.id, isPrimary: true } });
        await prisma.patientPhone.create({
          data: { companyId, patientId: patient.id, phone: c.phoneE164, isPrimary: hasPrimary === 0 },
        });
      }
    }
  }
  return dtos.length;
}

export async function syncRecords(companyId: string, client: YclientsClientHandle): Promise<number> {
  const dtos = await client.get<YclientsRecord[]>(client.endpoints.records(client.creds.companyId));
  let written = 0;
  for (const dto of dtos) {
    const r = mapRecord(dto);

    // Разрешение внешних ключей проекции. Запись без пациента/персонала пропускаем
    // (patientId и staffId в Appointment обязательны).
    const staff = await prisma.staff.findFirst({
      where: { companyId, yclientsStaffId: r.yclientsStaffId },
      select: { id: true },
    });
    if (!staff) continue;

    const patient = dto.client?.id
      ? await prisma.patient.findFirst({ where: { companyId, yclientsId: dto.client.id }, select: { id: true } })
      : r.clientPhoneE164
        ? await prisma.patientPhone
            .findFirst({ where: { companyId, phone: r.clientPhoneE164 }, select: { patientId: true } })
            .then((p) => (p ? { id: p.patientId } : null))
        : null;
    if (!patient) continue;

    const room = r.yclientsResourceId
      ? await prisma.room.findFirst({
          where: { companyId, yclientsResourceId: r.yclientsResourceId },
          select: { id: true },
        })
      : null;
    const primaryService = r.yclientsServiceIds[0]
      ? await prisma.service.findFirst({
          where: { companyId, yclientsServiceId: r.yclientsServiceIds[0] },
          select: { id: true },
        })
      : null;

    const endAt = new Date(r.startAt.getTime() + r.durationMin * 60_000);
    await prisma.appointment.upsert({
      where: { companyId_yclientsRecordId: { companyId, yclientsRecordId: r.yclientsRecordId } },
      update: {
        staffId: staff.id,
        patientId: patient.id,
        roomId: room?.id ?? null,
        primaryServiceId: primaryService?.id ?? null,
        startAt: r.startAt,
        endAt,
        durationMin: r.durationMin,
        status: r.status,
        attendanceRaw: dto.visit_attendance ?? null,
        revenue: r.revenue,
        updatedAtYclients: r.startAt,
      },
      create: {
        companyId,
        yclientsRecordId: r.yclientsRecordId,
        staffId: staff.id,
        patientId: patient.id,
        roomId: room?.id ?? null,
        primaryServiceId: primaryService?.id ?? null,
        startAt: r.startAt,
        endAt,
        durationMin: r.durationMin,
        status: r.status,
        attendanceRaw: dto.visit_attendance ?? null,
        revenue: r.revenue,
        createdAtYclients: r.startAt,
        updatedAtYclients: r.startAt,
      },
    });
    written += 1;
  }
  return written;
}

// TODO(этап 1): syncCourses (абонементы БОС + ручные IV-курсы, §3.5) и
// syncTransactions (признание выручки по визитам, §8). У них нетривиальные
// бизнес-правила — реализуем вместе с воркером роллапов, а не угадываем здесь.
