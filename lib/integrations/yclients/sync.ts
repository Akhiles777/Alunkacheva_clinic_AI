import { prisma } from "@/lib/db";
import { getYclientsClient, type YclientsClientHandle } from "./client";
import { markFailed, markOk, markRunning, readCursor } from "./sync-cursor";
import { apiDate, hasNextPage, monthWindows, PAGE_SIZE } from "./paging";
import { HISTORY_YEARS } from "./config";
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
  let page = 1;
  let fetched = 0;

  /**
   * Клиенты забираются постранично. Раньше бралась одна страница: у клиники с
   * тысячей карточек импортировалась первая сотня, и «новые пациенты» считались
   * по неполной базе.
   */
  for (;;) {
    const res = await client.getPage<YclientsClient[]>(client.endpoints.clients(client.creds.companyId), {
      page,
      count: PAGE_SIZE,
    });
    const dtos = res.data ?? [];
    for (const dto of dtos) {
      await upsertClient(companyId, dto);
    }
    fetched += dtos.length;
    if (!hasNextPage({ received: dtos.length, pageSize: PAGE_SIZE, fetchedSoFar: fetched, totalCount: res.totalCount, page })) {
      break;
    }
    page += 1;
  }
  return fetched;
}

async function upsertClient(companyId: string, dto: YclientsClient): Promise<void> {
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

/**
 * Записи (приёмы).
 *
 * Три вещи, которых раньше не было и без которых выгрузка неполная:
 *
 *  1. Диапазон дат. Без start_date/end_date YCLIENTS отдаёт узкое окно по
 *     умолчанию — истории мы не получали вовсе, а «первичный/повторный»
 *     считался по огрызку.
 *  2. Постраничность внутри окна: в месяце у работающей клиники записей
 *     больше, чем помещается на страницу.
 *  3. Инкрементальность. Первый прогон идёт на HISTORY_YEARS назад, дальше —
 *     только с последней успешной синхронизации, иначе каждый запуск тянет
 *     всё заново и упирается в лимит запросов.
 */
export async function syncRecords(companyId: string, client: YclientsClientHandle): Promise<number> {
  const cursor = await readCursor(companyId, "RECORDS");
  const now = new Date();
  // Запас назад от последней синхронизации: запись могли изменить задним
  // числом, и без перекрытия такое изменение мы бы не увидели.
  const OVERLAP_DAYS = 7;
  const from = cursor?.lastSyncedAt
    ? new Date(cursor.lastSyncedAt.getTime() - OVERLAP_DAYS * 24 * 3600 * 1000)
    : new Date(Date.UTC(now.getUTCFullYear() - HISTORY_YEARS, now.getUTCMonth(), 1));
  // Вперёд берём будущие записи: расписание на месяцы вперёд — это тоже данные.
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 1));

  let written = 0;
  for (const window of monthWindows(from, to)) {
    written += await syncRecordsWindow(companyId, client, window.from, window.to);
  }
  return written;
}

async function syncRecordsWindow(
  companyId: string,
  client: YclientsClientHandle,
  from: Date,
  to: Date,
): Promise<number> {
  let page = 1;
  let fetched = 0;
  let written = 0;

  for (;;) {
    const res = await client.getPage<YclientsRecord[]>(client.endpoints.records(client.creds.companyId), {
      start_date: apiDate(from),
      end_date: apiDate(to),
      page,
      count: PAGE_SIZE,
    });
    const dtos = res.data ?? [];
    for (const dto of dtos) {
      if (await upsertRecord(companyId, dto)) written += 1;
    }
    fetched += dtos.length;
    if (!hasNextPage({ received: dtos.length, pageSize: PAGE_SIZE, fetchedSoFar: fetched, totalCount: res.totalCount, page })) {
      break;
    }
    page += 1;
  }
  return written;
}

/**
 * Одна запись в проекцию. Возвращает false, если записать не удалось —
 * например, не нашёлся специалист или пациент: в Appointment это обязательные
 * связи, а выдумывать их нельзя.
 */
async function upsertRecord(companyId: string, dto: YclientsRecord): Promise<boolean> {
  const r = mapRecord(dto);

  /**
   * Удалённую в YCLIENTS запись помечаем удалённой и у себя. Раньше такие
   * записи оставались в проекции навсегда: администратор удалял приём там, а в
   * отчётах он продолжал числиться и портил выручку с загрузкой.
   */
  if (dto.deleted) {
    await prisma.appointment.updateMany({
      where: { companyId, yclientsRecordId: r.yclientsRecordId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return false;
  }

  const staff = await prisma.staff.findFirst({
    where: { companyId, yclientsStaffId: r.yclientsStaffId },
    select: { id: true },
  });
  if (!staff) return false;

  const patient = dto.client?.id
    ? await prisma.patient.findFirst({ where: { companyId, yclientsId: dto.client.id }, select: { id: true } })
    : r.clientPhoneE164
      ? await prisma.patientPhone
          .findFirst({ where: { companyId, phone: r.clientPhoneE164 }, select: { patientId: true } })
          .then((p) => (p ? { id: p.patientId } : null))
      : null;
  if (!patient) return false;

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
      // Запись могли вернуть из удалённых — снимаем отметку.
      deletedAt: null,
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
  return true;
}

// TODO(этап 1): syncCourses (абонементы БОС + ручные IV-курсы, §3.5) и
// syncTransactions (признание выручки по визитам, §8). У них нетривиальные
// бизнес-правила — реализуем вместе с воркером роллапов, а не угадываем здесь.
