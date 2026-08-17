import { prisma } from "@/lib/db";

/**
 * Справочники для выгрузки, загруженные заранее.
 *
 * Разбор одной записи YCLIENTS требовал пяти отдельных обращений к базе:
 * найти специалиста, пациента, кабинет, услугу и записать визит. При задержке
 * до базы в 243 миллисекунды (замер на боевой) выгрузка двухлетней истории
 * работающей клиники — десять тысяч визитов и пять тысяч клиентов — заняла бы
 * больше пяти часов и не пережила бы ни один таймаут.
 *
 * Справочники клиники маленькие: услуги, специалисты и кабинеты — десятки
 * строк. Их достаточно прочитать один раз за прогон и дальше искать в памяти.
 * Пациентов много, поэтому они подтягиваются пачкой на страницу — по тем
 * идентификаторам и телефонам, которые в этой странице действительно есть.
 */
export interface SyncLookups {
  staffByYclientsId: Map<number, string>;
  /**
   * Кабинет по умолчанию у специалиста («Настройки → Сотрудники»).
   *
   * Нужен, когда клиника не ведёт кабинеты в YCLIENTS как ресурсы: тогда в
   * записях кабинета нет вовсе, и загрузку кабинетов считать не из чего.
   * Запасной путь прямо предусмотрен §2 CLAUDE.md — маппинг «специалист →
   * кабинет» на нашей стороне.
   */
  defaultRoomByStaffId: Map<string, string>;
  roomByResourceId: Map<number, string>;
  serviceByYclientsId: Map<number, string>;
  /** Пациенты по идентификатору YCLIENTS — пополняется по мере страниц. */
  patientByYclientsId: Map<number, string>;
  /** Пациенты по нормализованному телефону. */
  patientByPhone: Map<string, string>;
  /** Уже известные визиты: их идентификаторы в YCLIENTS. */
  knownRecordIds: Set<number>;
  /**
   * Кабинет услуги — когда он у неё ровно один.
   *
   * Третий и последний способ узнать кабинет визита. Кабинеты в YCLIENTS не
   * заведены как ресурсы, привязку «специалист → кабинет» клиника пока не
   * задала, и все визиты оставались без кабинета: загрузка кабинетов в отчётах
   * пустая при полной базе визитов. Если услуга проводится ровно в одном
   * кабинете, сомнений нет — БОС-терапия идёт в кабинете БОС-терапии. Если в
   * нескольких, гадать не будем.
   */
  roomByServiceId: Map<string, string>;
  /**
   * Цена услуги из справочника клиники, по идентификатору YCLIENTS.
   *
   * Нужна, когда в записи стоимость не проставлена: у клиники таких визитов
   * тысяча с лишним из четырёх с половиной, и все они давали нулевую выручку.
   * Заказчик определил выручку прямо: пришёл на услугу за 8000 ₽ — значит
   * 8000 ₽ (§8). Цену берём ту же, что клиника показывает пациенту.
   */
  priceByYclientsServiceId: Map<number, number>;
}

/** Прочитать справочники клиники один раз за прогон. */
export async function loadLookups(companyId: string): Promise<SyncLookups> {
  const [staff, rooms, services, serviceRooms] = await Promise.all([
    prisma.staff.findMany({
      where: { companyId, yclientsStaffId: { not: null } },
      select: { id: true, yclientsStaffId: true, defaultRoomId: true },
    }),
    prisma.room.findMany({
      where: { companyId, yclientsResourceId: { not: null } },
      select: { id: true, yclientsResourceId: true },
    }),
    prisma.service.findMany({
      where: { companyId, yclientsServiceId: { not: null } },
      select: { id: true, yclientsServiceId: true, price: true },
    }),
    prisma.serviceRoom.findMany({
      where: { service: { companyId } },
      select: { serviceId: true, roomId: true },
    }),
  ]);

  // Услуга с единственным кабинетом — однозначная привязка; с несколькими —
  // выбирать нельзя, оставляем визит без кабинета.
  const roomsOfService = new Map<string, Set<string>>();
  for (const link of serviceRooms) {
    const set = roomsOfService.get(link.serviceId) ?? new Set<string>();
    set.add(link.roomId);
    roomsOfService.set(link.serviceId, set);
  }
  const roomByServiceId = new Map<string, string>();
  for (const [serviceId, set] of roomsOfService) {
    if (set.size === 1) roomByServiceId.set(serviceId, [...set][0]);
  }

  return {
    staffByYclientsId: new Map(staff.map((s) => [s.yclientsStaffId!, s.id])),
    defaultRoomByStaffId: new Map(
      staff.filter((s) => s.defaultRoomId).map((s) => [s.id, s.defaultRoomId!]),
    ),
    roomByResourceId: new Map(rooms.map((r) => [r.yclientsResourceId!, r.id])),
    serviceByYclientsId: new Map(services.map((s) => [s.yclientsServiceId!, s.id])),
    patientByYclientsId: new Map(),
    patientByPhone: new Map(),
    knownRecordIds: new Set(),
    roomByServiceId,
    priceByYclientsServiceId: new Map(
      services.filter((s) => Number(s.price) > 0).map((s) => [s.yclientsServiceId!, Number(s.price)]),
    ),
  };
}

/**
 * Подтянуть пациентов и уже известные визиты для одной страницы выгрузки.
 *
 * Берём ровно то, что встретилось на странице: тянуть всю базу пациентов в
 * память нельзя — у работающей клиники их тысячи.
 */
export async function primePage(
  companyId: string,
  lookups: SyncLookups,
  page: { clientIds: number[]; phones: string[]; recordIds: number[] },
): Promise<void> {
  const missingIds = page.clientIds.filter((id) => !lookups.patientByYclientsId.has(id));
  const missingPhones = page.phones.filter((p) => !lookups.patientByPhone.has(p));

  const [byId, byPhone, known] = await Promise.all([
    missingIds.length > 0
      ? prisma.patient.findMany({
          where: { companyId, yclientsId: { in: missingIds } },
          select: { id: true, yclientsId: true },
        })
      : Promise.resolve([]),
    missingPhones.length > 0
      ? prisma.patientPhone.findMany({
          where: { companyId, phone: { in: missingPhones } },
          select: { patientId: true, phone: true },
        })
      : Promise.resolve([]),
    page.recordIds.length > 0
      ? prisma.appointment.findMany({
          where: { companyId, yclientsRecordId: { in: page.recordIds } },
          select: { yclientsRecordId: true },
        })
      : Promise.resolve([]),
  ]);

  for (const p of byId) if (p.yclientsId !== null) lookups.patientByYclientsId.set(p.yclientsId, p.id);
  for (const p of byPhone) lookups.patientByPhone.set(p.phone, p.patientId);
  for (const a of known) if (a.yclientsRecordId !== null) lookups.knownRecordIds.add(a.yclientsRecordId);
}
