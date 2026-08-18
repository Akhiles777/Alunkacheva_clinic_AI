import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { getYclientsClient, type YclientsClientHandle } from "./client";
import { markFailed, markOk, markRunning, readCursor } from "./sync-cursor";
import { apiDate, hasNextPage, monthWindows, PAGE_SIZE } from "./paging";
import { CLIENT_FIELDS, HISTORY_YEARS } from "./config";
import { backfillFirstSeen, backfillRooms, recomputeVisitKinds } from "@/lib/metrics/recompute";
import { loadLookups, primePage, type SyncLookups } from "./lookups";
import { recordChanged } from "./changed";
import { cancelVanished, windowIsTrustworthy } from "./vanished";
import { adoptCandidate } from "./adopt";
import { pushPendingAppointments } from "./write-back";
import {
  mapClient,
  mapRecord,
  mapResource,
  mapService,
  mapStaff,
  type AppointmentUpsert,
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
  counts: Partial<Record<"services" | "staff" | "resources" | "clients" | "records" | "visitKinds" | "rooms" | "firstSeen", number>>;
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
   * После выгрузки — пересчёт первичных и повторных визитов.
   *
   * Классификация зависит от всей истории пациента, а не от отдельной записи,
   * поэтому её нельзя проставить при вставке. Без этого шага после выгрузки
   * первичных в отчётах ноль, а в списке пациентов все выглядят новыми —
   * данные есть, а метрики врут.
   */
  try {
    const marked = await recomputeVisitKinds(companyId);
    counts.visitKinds = marked.updated;
    // Кабинеты по специалистам: привязку могли задать уже после выгрузки.
    counts.rooms = await backfillRooms(companyId);
    // Дата первого обращения не позже первого визита: чиним уже загруженные.
    counts.firstSeen = await backfillFirstSeen(companyId);
  } catch (e) {
    errors.push(`VISIT_KINDS: ${(e as Error).message}`);
  }

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

  /**
   * Услуги, заведённые в настройках и ещё не связанные с YCLIENTS.
   *
   * Именно так справочник и задвоился в прошлый раз: клиника завела услугу
   * руками, выгрузка не узнала номер и создала вторую строку под тем же
   * названием. Визиты ссылались на приезжую, кабинет был указан у заведённой —
   * и кабинет визита не находился.
   */
  const unlinked = await prisma.service.findMany({
    where: { companyId, yclientsServiceId: null },
    select: { id: true, title: true },
  });

  for (const dto of dtos) {
    const s = mapService(dto);
    const own = adoptCandidate(s.title, unlinked);
    if (own) {
      // Связываем свою строку вместо создания второй. Привязки к кабинетам,
      // база знаний и ссылки визитов остаются при ней.
      const linked = await prisma.service.updateMany({
        where: { id: own, companyId, yclientsServiceId: null },
        data: { yclientsServiceId: s.yclientsServiceId, title: s.title, price: s.price, durationMin: s.durationMin, isActive: s.isActive },
      });
      if (linked.count > 0) continue;
    }
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

  // Специалисты, заведённые в настройках и ещё не связанные с YCLIENTS: иначе
  // рядом с ними появятся вторые, и приёмы разъедутся по двум карточкам.
  const unlinked = (
    await prisma.staff.findMany({
      where: { companyId, yclientsStaffId: null, deletedAt: null },
      select: { id: true, name: true },
    })
  ).map((r) => ({ id: r.id, title: r.name }));

  for (const dto of dtos) {
    const s = mapStaff(dto);
    const own = adoptCandidate(s.name, unlinked);
    if (own) {
      const linked = await prisma.staff.updateMany({
        where: { id: own, companyId, yclientsStaffId: null },
        data: { yclientsStaffId: s.yclientsStaffId, name: s.name, specialty: s.specialty, isActive: s.isActive },
      });
      if (linked.count > 0) continue;
    }
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

  /**
   * Кабинеты клиника завела у нас руками — в YCLIENTS их как ресурсы не ведут.
   * Заведут — и без этой связки рядом с тремя кабинетами появятся ещё три, а
   * загрузка размажется по шести.
   */
  const unlinked = (
    await prisma.room.findMany({
      where: { companyId, yclientsResourceId: null },
      select: { id: true, name: true },
    })
  ).map((r) => ({ id: r.id, title: r.name }));

  for (const dto of dtos) {
    const r = mapResource(dto);
    const own = adoptCandidate(r.name, unlinked);
    if (own) {
      const linked = await prisma.room.updateMany({
        where: { id: own, companyId, yclientsResourceId: null },
        data: { yclientsResourceId: r.yclientsResourceId },
      });
      if (linked.count > 0) continue;
    }
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
    /**
     * Поиск клиентов у YCLIENTS работает только методом POST, страница и
     * размер идут в теле: на GET адрес отвечает 405.
     *
     * Список полей обязателен. Без него приходит один идентификатор — ни
     * имени, ни телефона, — и в базе появляются пустые карточки, к которым
     * невозможно привязать ни визит, ни переписку.
     */
    const res = await client.postPage<YclientsClient[]>(client.endpoints.clients(client.creds.companyId), {
      page,
      count: PAGE_SIZE,
      fields: CLIENT_FIELDS,
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

  const toCreate: {
    name: string | null;
    yclientsId: number;
    phone: string | null;
    firstSeenAt: Date | null;
  }[] = [];
  const adopt: { patientId: string; yclientsId: number }[] = [];
  const rename: { patientId: string; name: string }[] = [];

  for (const { c } of mapped) {
    const existing =
      patientByYclientsId.get(c.yclientsId) ??
      (c.phoneE164 ? patientByPhone.get(c.phoneE164) : undefined);

    if (!existing) {
      toCreate.push({
        name: c.name,
        yclientsId: c.yclientsId,
        phone: c.phoneE164,
        firstSeenAt: c.firstSeenAt,
      });
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
    /**
     * Дата первого обращения — из YCLIENTS, а не «сейчас».
     *
     * Прежде всем импортированным ставился день выгрузки: полторы тысячи
     * человек с многолетней историей разом становились первичными, а метрика
     * «новые пациенты» за месяц импорта показывала всю базу клиники.
     */
    data: toCreate.map((p) => ({
      companyId,
      yclientsId: p.yclientsId,
      name: p.name,
      firstSeenAt: p.firstSeenAt ?? new Date(),
      /**
       * Даты первого визита у клиента нет — значит дату первого обращения мы
       * не знаем. Ставим день переноса, но помечаем как неточную: иначе вся
       * старая база разом попадёт в «новых пациентов» того месяца, когда
       * запустили выгрузку. Ровно это и произошло 14 августа.
       */
      firstSeenExact: p.firstSeenAt !== null,
    })),
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
        data: {
          companyId,
          yclientsId: c.yclientsId,
          name: c.name,
          firstSeenAt: c.firstSeenAt ?? new Date(),
          firstSeenExact: c.firstSeenAt !== null,
        },
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

  /**
   * Отметку «пришёл» администратор ставит задним числом.
   *
   * Окно догона считается по дате визита, а не по времени изменения записи:
   * такого фильтра у YCLIENTS нет. Пока запас был семь дней, визит, отмеченный
   * через неделю после приёма, не попадал в окно уже никогда — и навсегда
   * оставался «созданным». В отчётах это выглядело как «приёмов шестнадцать,
   * пришёл один».
   *
   * Поэтому последний месяц перечитываем всегда, независимо от курсора. Это
   * тридцать запросов в месяц против вечно неверной статистики.
   */
  const ATTENDANCE_WINDOW_DAYS = 30;
  const catchUp = new Date(now.getTime() - ATTENDANCE_WINDOW_DAYS * 24 * 3600 * 1000);

  const incremental = cursor?.lastSyncedAt
    ? new Date(cursor.lastSyncedAt.getTime() - OVERLAP_DAYS * 24 * 3600 * 1000)
    : new Date(Date.UTC(now.getUTCFullYear() - HISTORY_YEARS, now.getUTCMonth(), 1));
  const from = incremental < catchUp ? incremental : catchUp;
  // Вперёд берём будущие записи: расписание на месяцы вперёд — это тоже данные.
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 1));

  /**
   * Справочники читаем один раз за прогон, а не на каждую запись. Пять
   * обращений к базе на визит при задержке 243 мс превращали выгрузку
   * двухлетней истории в пять с лишним часов.
   */
  const lookups = await loadLookups(companyId);

  let written = 0;
  /** Всё, что YCLIENTS показал за эту выгрузку — по всем окнам сразу. */
  const seenAll = new Set<number>();
  let mainTrusted = true;

  for (const window of monthWindows(from, to)) {
    const res = await syncRecordsWindow(companyId, client, window.from, window.to, lookups);
    written += res.written;
    for (const id of res.seenIds) seenAll.add(id);
    if (!res.trusted) mainTrusted = false;
  }

  /**
   * Один месяц истории сверх окна — по кругу.
   *
   * Обычная выгрузка перечитывает последний месяц. Значит запись, перенесённую
   * из июня в август, мы увидим в августе, а её старую копию в июне — нет:
   * июнь больше не читается. Копия остаётся навсегда, с отметкой «пришёл» и
   * своей выручкой. Ровно так и появляются дубли, которых в YCLIENTS нет.
   *
   * Гонять всю историю каждый круг нельзя — это сотни запросов. Поэтому каждый
   * час проверяется следующий месяц: за сутки обходится два года, и дальше по
   * кругу, без чьего-либо участия. Полная выгрузка руками больше не нужна.
   */
  const audit = auditWindow(now, from);
  let auditTrusted = false;
  if (audit) {
    const res = await syncRecordsWindow(companyId, client, audit.from, audit.to, lookups);
    written += res.written;
    for (const id of res.seenIds) seenAll.add(id);
    auditTrusted = res.trusted;
  }

  /**
   * Сверка — один раз и по всей выгрузке.
   *
   * Наши визиты, номеров которых YCLIENTS не показал нигде, там удалены или
   * отменены. Сравнивать по одному окну нельзя: перенос на другой месяц из
   * своего окна выглядит точно так же, как удаление.
   */
  const ids = [...seenAll];
  const cancelled =
    (await cancelVanished(companyId, { from, to }, ids, mainTrusted)).cancelled +
    (audit ? (await cancelVanished(companyId, audit, ids, auditTrusted)).cancelled : 0);
  if (cancelled > 0) {
    console.log(`[выгрузка] отменено ${cancelled} визитов — в YCLIENTS их больше нет`);
  }

  return written;
}

/**
 * Какой месяц истории проверяем в этот раз.
 *
 * Смещение считается по часам от начала эпохи: каждый час — следующий месяц,
 * за сутки обходится вся история. Хранить позицию не нужно, а значит нечему и
 * сбиться при перезапуске.
 *
 * Возвращает null, если выбранный месяц и так попадает в обычное окно
 * выгрузки: перечитывать его второй раз незачем.
 */
export function auditWindow(now: Date, notBefore?: Date): { from: Date; to: Date } | null {
  const months = HISTORY_YEARS * 12;
  const offset = (Math.floor(now.getTime() / 3600_000) % months) + 1;
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset + 1, 1));
  if (notBefore && to > notBefore) return null;
  return { from, to };
}

/**
 * Ключ «один и тот же приём»: пациент, специалист и точное время начала.
 * Три совпадения подряд случайными не бывают.
 */
function localKey(patientId: string, staffId: string, startAt: Date): string {
  return `${patientId}|${staffId}|${startAt.getTime()}`;
}

interface WindowResult {
  written: number;
  /** Номера записей, которые YCLIENTS показал за это окно. */
  seenIds: number[];
  /** Можно ли верить окну настолько, чтобы отменять по нему визиты. */
  trusted: boolean;
}

async function syncRecordsWindow(
  companyId: string,
  client: YclientsClientHandle,
  from: Date,
  to: Date,
  lookups: SyncLookups,
): Promise<WindowResult> {
  let page = 1;
  let fetched = 0;
  let written = 0;
  let totalCount: number | null = null;
  /**
   * Полный список записей окна.
   *
   * Нужен не для вставки — для сверки: всё наше, чего в этом списке нет, в
   * YCLIENTS отменено или удалено. Удалённая запись оттуда просто перестаёт
   * приходить, и по одному её состоянию узнать об этом нельзя.
   */
  const seenIds: number[] = [];

  /**
   * Визиты, заведённые у нас и ещё не получившие номер YCLIENTS.
   *
   * Второй путь появления дублей. Администратор создал запись в нашей форме,
   * отправка в YCLIENTS не прошла (не связан специалист, нет телефона), а в
   * YCLIENTS ту же запись завели руками. Выгрузка не знает её номера и
   * создаёт ВТОРУЮ строку: один приём, два визита, двойная выручка и два
   * места в кабинете.
   *
   * Совпадение по пациенту, специалисту и точному времени начала — это один и
   * тот же приём. Тогда не создаём новый визит, а достраиваем существующий:
   * заметка администратора, привязка к диалогу и источник обращения остаются
   * при нём.
   */
  const orphans = new Map<string, string>();
  for (const row of await prisma.appointment.findMany({
    where: {
      companyId,
      deletedAt: null,
      yclientsRecordId: null,
      startAt: { gte: from, lt: to },
    },
    select: { id: true, patientId: true, staffId: true, startAt: true },
  })) {
    orphans.set(localKey(row.patientId, row.staffId, row.startAt), row.id);
  }

  for (;;) {
    const res = await client.getPage<YclientsRecord[]>(client.endpoints.records(client.creds.companyId), {
      start_date: apiDate(from),
      end_date: apiDate(to),
      page,
      count: PAGE_SIZE,
    });
    const dtos = res.data ?? [];
    if (typeof res.totalCount === "number") totalCount = res.totalCount;
    for (const d of dtos) seenIds.push(d.id);

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
      const recordId = row.data.yclientsRecordId as number;
      if (lookups.knownRecordIds.has(recordId)) {
        /**
         * Переписываем, только если что-то изменилось.
         *
         * Последний месяц перечитывается каждым кругом, и безусловное
         * обновление ставило свежую отметку изменения всем прочитанным
         * визитам. Ответить «что принесла выгрузка» было нечем: по базе
         * выходило, что меняется всё сразу и каждые пятнадцать минут.
         */
        const existing = lookups.existingRecords.get(recordId);
        if (existing && !recordChanged({ existing, incoming: row.data, createdAtKnown: row.createdAtKnown })) {
          continue;
        }
        // Дату создания не трогаем, если провайдер её не прислал: там заглушка.
        const { createdAtYclients: _stub, ...withoutCreatedAt } = row.data;
        await prisma.appointment.updateMany({
          where: { companyId, yclientsRecordId: recordId },
          data: row.createdAtKnown
            ? { ...row.data, deletedAt: null }
            : { ...withoutCreatedAt, deletedAt: null },
        });
      } else {
        /**
         * Не заводим второй визит там, где он уже есть под нашим номером:
         * достраиваем свой. Иначе один приём превращается в два — с двойной
         * выручкой и двумя местами в расписании кабинета.
         */
        const key = localKey(
          row.data.patientId as string,
          row.data.staffId as string,
          row.data.startAt as Date,
        );
        const ownId = orphans.get(key);
        if (ownId) {
          orphans.delete(key);
          await prisma.appointment.updateMany({
            where: { id: ownId, companyId, yclientsRecordId: null },
            data: { ...row.data, deletedAt: null },
          });
        } else {
          creates.push(row.data);
        }
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

  /**
   * Сверку по этому окну не делаем здесь.
   *
   * Запись, перенесённую в другой месяц, из своего окна не отличить от
   * удалённой: её номера тут нет, а где он есть — станет известно только
   * после всех окон. Поэтому окно лишь сообщает, что видело, а решение об
   * отмене принимается один раз, по всей выгрузке.
   */
  return { written, seenIds, trusted: windowIsTrustworthy({ fetched, totalCount }) };
}

/**
 * Выручка визита.
 *
 * Обычно это стоимость услуг из записи YCLIENTS. Но у клиники тысяча с лишним
 * состоявшихся визитов приходит с нулевой стоимостью: администратор её не
 * проставил. Заказчик определил выручку прямо: пришёл на услугу за 8000 ₽ —
 * значит 8000 ₽ (§8), поэтому такой ноль закрывается ценой услуги.
 *
 * И ровно один случай, когда ноль трогать нельзя: скидка сто процентов.
 * Пациентке отдали приём даром, а в отчёте у неё стояло 3000 ₽ — выручка,
 * которой не было.
 *
 * Различает эти два случая только размер скидки. Ни цена по прайсу, ни
 * количество в записи не помогают: YCLIENTS кладёт их всегда, и по ним
 * незаполненная стоимость выглядит точно так же, как подарок. Одна проверка
 * этого вывода на живых данных стоила трёх миллионов рублей выручки,
 * обнулённых по ошибке.
 */
function revenueOf(r: AppointmentUpsert, lookups: SyncLookups): RevenueDecision {
  // Стоимость проставлена — это факт из кассы, других источников не нужно.
  if (r.revenue > 0) return { amount: r.revenue, source: "RECORD" };

  // Скидка сто процентов: услуга отдана даром. Ноль настоящий.
  if (r.isFree) return { amount: 0, source: "FREE" };

  /**
   * Стоимость не проставлена — подставляем цену.
   *
   * Сначала ту, что несёт сама запись (цена услуги на момент визита), потом
   * справочник клиники. Запись точнее: прайс с тех пор мог измениться.
   */
  if (r.listPrice > 0) return { amount: r.listPrice, source: "PRICE_LIST" };

  let sum = 0;
  for (const yclientsServiceId of r.yclientsServiceIds) {
    sum += lookups.priceByYclientsServiceId.get(yclientsServiceId) ?? 0;
  }
  return sum > 0 ? { amount: sum, source: "PRICE_LIST" } : { amount: 0, source: "UNKNOWN" };
}

/**
 * Откуда взялась сумма визита.
 *
 * Хранится вместе с визитом, потому что «выручка 3000 ₽» и «выручка 3000 ₽,
 * подставленная из прайса» — разные утверждения, а на экране они выглядят
 * одинаково. Без этого разобрать жалобу «почему у неё 3000, если было
 * бесплатно» можно только гаданием.
 */
export interface RevenueDecision {
  amount: number;
  source: "RECORD" | "PRICE_LIST" | "FREE" | "UNKNOWN";
}

/**
 * Кабинет визита — три источника по убыванию надёжности.
 *
 *   1. Ресурс из записи YCLIENTS. Так и задумано в §2, но клиника кабинеты как
 *      ресурсы не ведёт, и на боевых данных этого источника нет ни у одной
 *      записи.
 *   2. Кабинет специалиста из «Настройки → Сотрудники». Задаётся руками и на
 *      сегодня тоже пуст.
 *   3. Кабинет услуги — если он у неё ровно один. БОС-терапия идёт в кабинете
 *      БОС-терапии, тут сомнений нет.
 *
 * Ни один не подошёл — визит остаётся без кабинета. Выдумывать привязку
 * нельзя: загрузка кабинета это не оценка, а число, по которому принимают
 * решение о найме.
 */
function resolveRoom(
  r: AppointmentUpsert,
  staffId: string,
  lookups: SyncLookups,
): string | null {
  const fromResource = r.yclientsResourceId
    ? (lookups.roomByResourceId.get(r.yclientsResourceId) ?? null)
    : null;
  if (fromResource) return fromResource;

  const fromStaff = lookups.defaultRoomByStaffId.get(staffId);
  if (fromStaff) return fromStaff;

  const serviceId = r.yclientsServiceIds[0]
    ? lookups.serviceByYclientsId.get(r.yclientsServiceIds[0])
    : undefined;
  return serviceId ? (lookups.roomByServiceId.get(serviceId) ?? null) : null;
}

/** Что делать с записью: удалить у себя или записать данными. */
type RecordRow =
  | { kind: "deleted"; yclientsRecordId: number }
  | {
      kind: "row";
      data: Prisma.AppointmentCreateManyInput;
      /**
       * Прислал ли провайдер дату создания записи. Если нет, в data лежит
       * дата визита — как заглушка для новой строки. Обновлять ею уже
       * известную дату нельзя: однажды полученная правда не должна теряться
       * из-за того, что в следующем ответе поля не оказалось.
       */
      createdAtKnown: boolean;
    };

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
  const revenue = revenueOf(r, lookups);
  return {
    kind: "row",
    createdAtKnown: r.createdAtYclients !== null,
    data: {
      companyId,
      yclientsRecordId: r.yclientsRecordId,
      staffId,
      patientId,
      /**
       * Кабинет: из записи YCLIENTS, а если его там нет — по специалисту.
       *
       * Клиника не ведёт кабинеты в YCLIENTS как ресурсы, поэтому в записях
       * их нет вовсе, и загрузку кабинетов считать было не из чего. Запасной
       * путь предусмотрен §2: маппинг «специалист → кабинет» задаётся в
       * «Настройки → Сотрудники». Пока он не задан, визит остаётся без
       * кабинета — выдумывать привязку нельзя.
       */
      roomId: resolveRoom(r, staffId, lookups),
      primaryServiceId: r.yclientsServiceIds[0]
        ? (lookups.serviceByYclientsId.get(r.yclientsServiceIds[0]) ?? null)
        : null,
      startAt: r.startAt,
      endAt,
      durationMin: r.durationMin,
      status: r.status,
      attendanceRaw: dto.visit_attendance ?? null,
      yclientsVisitId: r.yclientsVisitId,
      revenue: revenue.amount,
      // Откуда сумма: без этого «3000 ₽» и «3000 ₽ из прайса» неразличимы.
      revenueSource: revenue.source,
      isPaid: r.isPaid,
      /**
       * Дата создания записи — из YCLIENTS. Здесь стояла дата визита, и
       * метрика «записались за месяц» на деле показывала «приёмов за месяц»:
       * записавшийся в августе на сентябрь в августовскую цифру не попадал.
       * Провайдер поля не прислал — оставляем дату визита, но это видно в
       * отчёте отдельной оговоркой, а не молча.
       */
      createdAtYclients: r.createdAtYclients ?? r.startAt,
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
      // Оплату обновляем тоже: визит оплачивают после приёма, и без этого
      // отметка об оплате никогда бы не доехала до уже созданной записи.
      isPaid: r.isPaid,
      ...(r.createdAtYclients ? { createdAtYclients: r.createdAtYclients } : {}),
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
      isPaid: r.isPaid,
      createdAtYclients: r.createdAtYclients ?? r.startAt,
      updatedAtYclients: r.startAt,
    },
  });
  return true;
}

// TODO(этап 1): syncCourses (абонементы БОС + ручные IV-курсы, §3.5) и
// syncTransactions (признание выручки по визитам, §8). У них нетривиальные
// бизнес-правила — реализуем вместе с воркером роллапов, а не угадываем здесь.
