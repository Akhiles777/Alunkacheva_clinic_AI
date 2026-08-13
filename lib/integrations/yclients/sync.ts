import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { getYclientsClient, type YclientsClientHandle } from "./client";
import { markFailed, markOk, markRunning, readCursor } from "./sync-cursor";
import { apiDate, hasNextPage, monthWindows, PAGE_SIZE } from "./paging";
import { HISTORY_YEARS } from "./config";
import { loadLookups, primePage, type SyncLookups } from "./lookups";
import { pushPendingAppointments } from "./write-back";
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

  /**
   * После приёма данных отправляем своё. Порядок важен: сначала забираем
   * чужие записи, потом отдаём свои — так поиск уже созданной записи видит
   * актуальное расписание и не создаёт дубль.
   */
  const pushed = await pushPendingAppointments(companyId);
  if (pushed.conflicts > 0) {
    errors.push(`Не удалось отправить в YCLIENTS: слот занят у ${pushed.conflicts} визитов`);
  }
  if (pushed.failed > 0) {
    errors.push(`Не удалось отправить в YCLIENTS: ${pushed.failed} визитов`);
  }

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

    /**
     * Пациентов страницы обрабатываем пачкой: сначала одним заходом узнаём,
     * кто из них уже есть — по идентификатору YCLIENTS и по телефону, — потом
     * вставляем новых одним запросом. Поштучный разбор стоил пяти обращений к
     * базе на человека: пять тысяч клиентов превращались в часы.
     */
    await upsertClientsPage(companyId, dtos);
    fetched += dtos.length;
    if (!hasNextPage({ received: dtos.length, pageSize: PAGE_SIZE, fetchedSoFar: fetched, totalCount: res.totalCount, page })) {
      break;
    }
    page += 1;
  }
  return fetched;
}

/**
 * Страница клиентов одним заходом.
 *
 * Порядок сопоставления тот же, что и поштучно (§4): сначала идентификатор
 * YCLIENTS, затем телефон. Разница только в том, что справки берутся сразу на
 * всю страницу, а новые карточки создаются одним запросом.
 */
async function upsertClientsPage(companyId: string, dtos: YclientsClient[]): Promise<void> {
  if (dtos.length === 0) return;

  const mapped = dtos.map((dto) => ({ dto, c: mapClient(dto) }));
  const ids = mapped.map((m) => m.c.yclientsId);
  const phones = mapped.map((m) => m.c.phoneE164).filter((p): p is string => Boolean(p));

  const [byId, byPhone] = await Promise.all([
    prisma.patient.findMany({
      where: { companyId, yclientsId: { in: ids } },
      select: { id: true, yclientsId: true },
    }),
    phones.length > 0
      ? prisma.patientPhone.findMany({
          where: { companyId, phone: { in: phones } },
          select: { patientId: true, phone: true },
        })
      : Promise.resolve([]),
  ]);
  const patientByYclientsId = new Map(byId.map((p) => [p.yclientsId!, p.id]));
  const patientByPhone = new Map(byPhone.map((p) => [p.phone, p.patientId]));

  const toCreate: { name: string | null; yclientsId: number; phone: string | null }[] = [];
  const adopt: { patientId: string; yclientsId: number }[] = [];
  const rename: { patientId: string; name: string }[] = [];

  for (const { c } of mapped) {
    const existing =
      patientByYclientsId.get(c.yclientsId) ??
      (c.phoneE164 ? patientByPhone.get(c.phoneE164) : undefined);

    if (!existing) {
      toCreate.push({ name: c.name, yclientsId: c.yclientsId, phone: c.phoneE164 });
      continue;
    }
    // Нашли по телефону — закрепляем идентификатор YCLIENTS за этой карточкой.
    if (!patientByYclientsId.has(c.yclientsId)) adopt.push({ patientId: existing, yclientsId: c.yclientsId });
    if (c.name) rename.push({ patientId: existing, name: c.name });
  }

  for (const a of adopt) {
    await prisma.patient
      .update({ where: { id: a.patientId }, data: { yclientsId: a.yclientsId } })
      .catch(() => {});
  }
  for (const r of rename) {
    await prisma.patient.update({ where: { id: r.patientId }, data: { name: r.name } }).catch(() => {});
  }

  if (toCreate.length === 0) return;

  await prisma.patient.createMany({
    data: toCreate.map((p) => ({ companyId, yclientsId: p.yclientsId, name: p.name, firstSeenAt: new Date() })),
    skipDuplicates: true,
  });

  // Телефоны новым карточкам: идентификаторы узнаём одним запросом после вставки.
  const created = await prisma.patient.findMany({
    where: { companyId, yclientsId: { in: toCreate.map((p) => p.yclientsId) } },
    select: { id: true, yclientsId: true },
  });
  const createdById = new Map(created.map((p) => [p.yclientsId!, p.id]));
  const phoneRows = toCreate
    .filter((p) => p.phone && createdById.has(p.yclientsId))
    .map((p) => ({ companyId, patientId: createdById.get(p.yclientsId)!, phone: p.phone!, isPrimary: true }));
  if (phoneRows.length > 0) {
    // Номер мог уже принадлежать другому пациенту — уникальный индекс это
    // остановит, и такая строка просто не создастся.
    await prisma.patientPhone.createMany({ data: phoneRows, skipDuplicates: true });
  }
}

export async function upsertClient(companyId: string, dto: YclientsClient): Promise<void> {
  const c = mapClient(dto);

  /**
   * Пациента ищем сначала по идентификатору YCLIENTS, потом по телефону.
   *
   * Телефон — единственный надёжный ключ сопоставления (§4). Прежний порядок
   * искал только по идентификатору, а телефон проверял в пределах уже
   * найденной карточки: клиент, заведённый до интеграции вручную, при выгрузке
   * получал вторую карточку с тем же номером. Дальше визиты распределялись
   * между двумя карточками произвольно — какую вернёт запрос, к той и
   * привяжутся, — и история пациента разъезжалась.
   */
  let patientId: string | null =
    (await prisma.patient.findFirst({
      where: { companyId, yclientsId: c.yclientsId },
      select: { id: true },
    }))?.id ?? null;

  if (!patientId && c.phoneE164) {
    const byPhone = await prisma.patientPhone.findFirst({
      where: { companyId, phone: c.phoneE164 },
      select: { patientId: true },
    });
    if (byPhone) {
      patientId = byPhone.patientId;
      // Нашли по телефону — закрепляем за карточкой идентификатор YCLIENTS,
      // чтобы дальше сопоставление шло по нему напрямую.
      await prisma.patient
        .update({ where: { id: patientId }, data: { yclientsId: c.yclientsId } })
        .catch(() => {});
    }
  }

  if (patientId) {
    // Имя из YCLIENTS не затирает заполненное локально пустым значением.
    if (c.name) await prisma.patient.update({ where: { id: patientId }, data: { name: c.name } });
  } else {
    patientId = (
      await prisma.patient.create({
        data: { companyId, yclientsId: c.yclientsId, name: c.name, firstSeenAt: new Date() },
        select: { id: true },
      })
    ).id;
  }

  if (!c.phoneE164) return;

  /**
   * Телефон проверяем по клинике целиком, а не по карточке: один номер не
   * может принадлежать двум пациентам, иначе теряется смысл сопоставления.
   */
  const existingPhone = await prisma.patientPhone.findFirst({
    where: { companyId, phone: c.phoneE164 },
    select: { id: true, patientId: true },
  });
  if (existingPhone) return;

  const hasPrimary = await prisma.patientPhone.count({
    where: { patientId, isPrimary: true },
  });
  await prisma.patientPhone
    .create({
      data: { companyId, patientId, phone: c.phoneE164, isPrimary: hasPrimary === 0 },
    })
    // Гонка при параллельной выгрузке: номер мог появиться между проверкой и
    // вставкой. Уникальный индекс её останавливает, и это не ошибка синка.
    .catch(() => {});
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

  /**
   * Справочники читаем один раз за прогон, а не на каждую запись. Пять
   * обращений к базе на визит при задержке 243 мс превращали выгрузку
   * двухлетней истории в пять с лишним часов.
   */
  const lookups = await loadLookups(companyId);

  let written = 0;
  for (const window of monthWindows(from, to)) {
    written += await syncRecordsWindow(companyId, client, window.from, window.to, lookups);
  }
  return written;
}

async function syncRecordsWindow(
  companyId: string,
  client: YclientsClientHandle,
  from: Date,
  to: Date,
  lookups: SyncLookups,
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

    /**
     * Подтягиваем всё нужное для страницы одним заходом: пациентов по
     * идентификаторам и телефонам и уже известные визиты. Дальше разбор идёт
     * в памяти.
     */
    await primePage(companyId, lookups, {
      clientIds: dtos.map((d) => d.client?.id).filter((x): x is number => typeof x === "number"),
      phones: dtos
        .map((d) => mapRecord(d).clientPhoneE164)
        .filter((x): x is string => typeof x === "string"),
      recordIds: dtos.map((d) => d.id),
    });

    /**
     * Новые визиты вставляем пачкой, а не по одному.
     *
     * При начальной выгрузке почти всё — новое, и отдельная запись на визит
     * была основной статьёй расходов: десять тысяч визитов это десять тысяч
     * обращений к базе. Уже известные обновляем поштучно — их немного.
     */
    const creates: Prisma.AppointmentCreateManyInput[] = [];
    for (const dto of dtos) {
      const row = buildRecordRow(companyId, dto, lookups);
      if (!row) continue;
      if (row.kind === "deleted") {
        await prisma.appointment.updateMany({
          where: { companyId, yclientsRecordId: row.yclientsRecordId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        continue;
      }
      if (lookups.knownRecordIds.has(row.data.yclientsRecordId as number)) {
        await prisma.appointment.updateMany({
          where: { companyId, yclientsRecordId: row.data.yclientsRecordId as number },
          data: { ...row.data, deletedAt: null },
        });
      } else {
        creates.push(row.data);
      }
      written += 1;
    }
    if (creates.length > 0) {
      await prisma.appointment.createMany({ data: creates, skipDuplicates: true });
    }

    fetched += dtos.length;
    if (!hasNextPage({ received: dtos.length, pageSize: PAGE_SIZE, fetchedSoFar: fetched, totalCount: res.totalCount, page })) {
      break;
    }
    page += 1;
  }
  return written;
}

/** Что делать с записью: удалить у себя или записать данными. */
type RecordRow =
  | { kind: "deleted"; yclientsRecordId: number }
  | { kind: "row"; data: Prisma.AppointmentCreateManyInput };

/**
 * Собрать строку визита из ответа YCLIENTS, ничего не спрашивая у базы.
 *
 * Отделено от записи намеренно: разбор идёт в памяти по готовым справочникам,
 * а обращения к базе группируются пачками. Иначе на визит приходилось пять
 * запросов, и выгрузка истории занимала часы.
 */
export function buildRecordRow(
  companyId: string,
  dto: YclientsRecord,
  lookups: SyncLookups,
): RecordRow | null {
  const r = mapRecord(dto);
  if (dto.deleted) return { kind: "deleted", yclientsRecordId: r.yclientsRecordId };

  const staffId = lookups.staffByYclientsId.get(r.yclientsStaffId);
  if (!staffId) return null;

  const patientId =
    (dto.client?.id !== undefined ? lookups.patientByYclientsId.get(dto.client.id) : undefined) ??
    (r.clientPhoneE164 ? lookups.patientByPhone.get(r.clientPhoneE164) : undefined);
  // Визит без пациента или специалиста в проекцию не пишем: это обязательные
  // связи, а выдумывать их нельзя.
  if (!patientId) return null;

  const endAt = new Date(r.startAt.getTime() + r.durationMin * 60_000);
  return {
    kind: "row",
    data: {
      companyId,
      yclientsRecordId: r.yclientsRecordId,
      staffId,
      patientId,
      roomId: r.yclientsResourceId ? (lookups.roomByResourceId.get(r.yclientsResourceId) ?? null) : null,
      primaryServiceId: r.yclientsServiceIds[0]
        ? (lookups.serviceByYclientsId.get(r.yclientsServiceIds[0]) ?? null)
        : null,
      startAt: r.startAt,
      endAt,
      durationMin: r.durationMin,
      status: r.status,
      attendanceRaw: dto.visit_attendance ?? null,
      revenue: r.revenue,
      createdAtYclients: r.startAt,
      updatedAtYclients: r.startAt,
      // Приехало из YCLIENTS — значит уже там есть.
      syncState: "SYNCED",
    },
  };
}

/**
 * Одна запись в проекцию. Возвращает false, если записать не удалось —
 * например, не нашёлся специалист или пациент: в Appointment это обязательные
 * связи, а выдумывать их нельзя.
 */
export async function upsertRecord(
  companyId: string,
  dto: YclientsRecord,
  /**
   * Готовые справочники. Не переданы — работаем поштучно: так приходит
   * одиночное событие вебхука, и ради него греть всю таблицу незачем.
   */
  lookups?: SyncLookups,
): Promise<boolean> {
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

  /**
   * Связи ищем в готовых справочниках, если они переданы. Обращение к базе
   * остаётся только там, где справочника нет, — на одиночном событии вебхука.
   */
  const staffId =
    lookups?.staffByYclientsId.get(r.yclientsStaffId) ??
    (lookups
      ? undefined
      : (
          await prisma.staff.findFirst({
            where: { companyId, yclientsStaffId: r.yclientsStaffId },
            select: { id: true },
          })
        )?.id);
  if (!staffId) return false;

  let patientId: string | undefined;
  if (dto.client?.id !== undefined) {
    patientId =
      lookups?.patientByYclientsId.get(dto.client.id) ??
      (lookups
        ? undefined
        : (
            await prisma.patient.findFirst({
              where: { companyId, yclientsId: dto.client.id },
              select: { id: true },
            })
          )?.id);
  }
  if (!patientId && r.clientPhoneE164) {
    patientId =
      lookups?.patientByPhone.get(r.clientPhoneE164) ??
      (lookups
        ? undefined
        : (
            await prisma.patientPhone.findFirst({
              where: { companyId, phone: r.clientPhoneE164 },
              select: { patientId: true },
            })
          )?.patientId);
  }
  if (!patientId) return false;

  const roomId = r.yclientsResourceId
    ? (lookups?.roomByResourceId.get(r.yclientsResourceId) ??
      (lookups
        ? null
        : (
            await prisma.room.findFirst({
              where: { companyId, yclientsResourceId: r.yclientsResourceId },
              select: { id: true },
            })
          )?.id ?? null))
    : null;

  const primaryServiceId = r.yclientsServiceIds[0]
    ? (lookups?.serviceByYclientsId.get(r.yclientsServiceIds[0]) ??
      (lookups
        ? null
        : (
            await prisma.service.findFirst({
              where: { companyId, yclientsServiceId: r.yclientsServiceIds[0] },
              select: { id: true },
            })
          )?.id ?? null))
    : null;

  const endAt = new Date(r.startAt.getTime() + r.durationMin * 60_000);
  await prisma.appointment.upsert({
    where: { companyId_yclientsRecordId: { companyId, yclientsRecordId: r.yclientsRecordId } },
    update: {
      staffId,
      patientId,
      roomId,
      primaryServiceId,
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
      staffId,
      patientId,
      roomId,
      primaryServiceId,
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
