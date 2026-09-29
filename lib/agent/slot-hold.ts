import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { fetchOutgoingStatuses, type ClinicStatusRow } from "@/lib/integrations/whatsapp/green-api";
import { forSomeoneElse } from "./status-slot";

/**
 * Окошко из статуса: занято ли оно и за кем закреплено.
 *
 * Записи в YCLIENTS агент не создаёт (§6): окошко закрепляется словами — «хорошо,
 * запишем вас на 12:15», — а оформляет запись администратор. Но слова обязаны
 * что-то значить. Статус с окошком видят десятки человек сразу, и двое
 * отвечают на него в одну минуту; без закрепления агент пообещал бы одно
 * окошко обоим. Поэтому закреплённое окошко лежит в `SlotHold` и считается
 * занятым наравне с записями, а само закрепление идёт под блокировкой.
 *
 * «Свободно» — это «в нашей базе на это время у этого врача никого нет». База —
 * копия YCLIENTS и отстаёт не больше чем на круг выгрузки (3 минуты); ровно
 * поэтому последнее слово всё равно за администратором, который оформляет
 * запись.
 */

export type HoldState = "CHOICE" | "OFFERED" | "HELD" | "RELEASED";

/** Сколько живёт вопрос «какое время?» и ожидание данных. */
export const OPEN_TTL_MS = 24 * 3600_000;

/**
 * Сколько окошек из статусов диалог держит одновременно.
 *
 * Мама записывает двоих детей — два окошка, это нормально. Десять — это уже не
 * запись, а занятое расписание, и решать такое должен человек.
 */
export const MAX_HELD = 3;

/** Длительность, если услуга не определилась: окошко меньше получаса клиника не выкладывает. */
export const DEFAULT_DURATION_MIN = 30;

type Db = typeof prisma | Prisma.TransactionClient;

// ───────────────────────────────────────── статусы клиники

/** Запомнить статусы клиники. Уже известный не переписываем: первое время публикации — верное. */
export async function recordClinicStatuses(
  companyId: string,
  rows: ClinicStatusRow[],
  source: "webhook" | "api",
): Promise<void> {
  for (const row of rows) {
    await prisma.clinicStatus
      .upsert({
        where: { companyId_externalId: { companyId, externalId: row.externalId } },
        update: {},
        create: { companyId, externalId: row.externalId, text: row.text, postedAt: row.postedAt, source },
      })
      .catch(() => {});
  }
}

const lastFetch = new Map<string, number>();
/**
 * Не чаще раза в 20 секунд на клинику. Первый же ответ на новый статус
 * забирает у провайдера все статусы за сутки, и следующие ответы находят его
 * в базе; предел нужен против цитат, которых у провайдера нет вовсе.
 */
const FETCH_EVERY_MS = 20_000;

/** Статус живёт сутки — ищем с запасом. */
const STATUS_WINDOW_MS = 26 * 3600_000;

/** Текст статуса в сравнимом виде: регистр, «ё» и переносы строк не важны. */
function statusKey(text: string | null | undefined): string {
  return (text ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/**
 * Время публикации — по номеру статуса, а если номер не совпал, по тексту.
 *
 * Номер надёжнее, но цитата и список статусов приходят от провайдера разными
 * путями, и полагаться только на их совпадение нельзя. Текст годится, если за
 * сутки такой статус был ровно один: вчерашний и сегодняшний «Окошко на
 * завтра … 15:00» дословно одинаковы, и тогда день не угадываем.
 */
async function knownPostedAt(companyId: string, externalId: string | null, text: string | null): Promise<Date | null> {
  if (externalId) {
    const byId = await prisma.clinicStatus
      .findUnique({ where: { companyId_externalId: { companyId, externalId } }, select: { postedAt: true } })
      .catch(() => null);
    if (byId) return byId.postedAt;
  }
  const key = statusKey(text);
  if (!key) return null;
  const rows = await prisma.clinicStatus
    .findMany({
      where: { companyId, postedAt: { gt: new Date(Date.now() - STATUS_WINDOW_MS) } },
      select: { text: true, postedAt: true },
    })
    .catch(() => []);
  // Один статус, сохранённый дважды (вебхуком и запросом), — одна публикация.
  const times = [...new Set(rows.filter((r) => statusKey(r.text) === key).map((r) => r.postedAt.getTime()))];
  return times.length === 1 ? new Date(times[0]) : null;
}

/**
 * Когда выложен статус, на который ответили.
 *
 * Сначала — то, что уже сохранено; потом — вопрос провайдеру. null значит
 * «не знаем», и тогда «на завтра» переспрашивается у пациента, а не
 * угадывается.
 */
export async function statusPostedAt(
  companyId: string,
  externalId: string | null,
  text: string | null = null,
): Promise<Date | null> {
  const known = await knownPostedAt(companyId, externalId, text);
  if (known) return known;

  const last = lastFetch.get(companyId) ?? 0;
  if (Date.now() - last >= FETCH_EVERY_MS) {
    lastFetch.set(companyId, Date.now());
    const rows = await fetchOutgoingStatuses(companyId, STATUS_WINDOW_MS / 60_000).catch(() => null);
    if (rows) await recordClinicStatuses(companyId, rows, "api");
  }
  const found = await knownPostedAt(companyId, externalId, text);
  /**
   * В журнал — только вывод, без текста статуса и номеров: по нему видно,
   * работает ли на боевом аккаунте определение дня, а больше в журнале ничего
   * не нужно.
   */
  console.log(`[agent] окошко из статуса: время публикации ${found ? "найдено" : "не найдено — день уточним у пациента"}`);
  return found;
}

/** Цитата — это известный нам статус клиники: значит, её автор точно клиника. */
export async function isKnownClinicStatus(
  companyId: string,
  externalId: string | null,
  text: string | null = null,
): Promise<boolean> {
  return (await knownPostedAt(companyId, externalId, text)) !== null;
}

// ───────────────────────────────────────── занятость

export interface SlotRef {
  companyId: string;
  conversationId: string;
  patientId: string | null;
  staffId: string;
  startAt: Date;
  durationMin: number;
}

/**
 * free — у врача на это время никого; taken — занято другим; mine — уже
 * закреплено за этим диалогом; booked — пациент уже записан на это время.
 */
export type SlotState = "free" | "taken" | "mine" | "booked";

/**
 * «На это время кто-то есть» — окно вокруг начала окошка.
 *
 * Длительность услуги из прайса для этого не годится. У клиники окошки стоят
 * плотно — 15:00 и 15:40, 16:30 и 16:50, — а приём по прайсу 45 минут: по
 * длительности 15:00 считалось бы занятым, стоило кому-то взять 15:40. Сетку
 * знает администратор, и оба окошка он выложил сам. Поэтому занято — это
 * запись, которая идёт в момент начала окошка или начинается в первые
 * двадцать минут после него, и другое закреплённое окошко ближе двадцати
 * минут к этому.
 */
export const SLOT_WINDOW_MIN = 20;

async function slotState(db: Db, s: SlotRef, excludeHoldId?: string): Promise<SlotState> {
  const windowMs = Math.min(s.durationMin, SLOT_WINDOW_MIN) * 60_000;
  const end = new Date(s.startAt.getTime() + windowMs);

  /**
   * Записи врача на это время. Отменённые и удалённые не мешают: отменённая
   * запись и есть то, что освобождает окошко.
   */
  const visits = await db.appointment.findMany({
    where: {
      companyId: s.companyId,
      staffId: s.staffId,
      deletedAt: null,
      status: { not: "CANCELLED" },
      startAt: { lt: end },
      endAt: { gt: s.startAt },
    },
    select: { patientId: true },
  });
  if (s.patientId && visits.some((v) => v.patientId === s.patientId)) return "booked";
  if (visits.length > 0) return "taken";

  /** Окошки, закреплённые агентом: занято, если начало ближе двадцати минут. */
  const holds = await db.slotHold.findMany({
    where: {
      companyId: s.companyId,
      staffId: s.staffId,
      state: "HELD",
      ...(excludeHoldId ? { id: { not: excludeHoldId } } : {}),
      startAt: {
        gt: new Date(s.startAt.getTime() - SLOT_WINDOW_MIN * 60_000),
        lt: new Date(s.startAt.getTime() + SLOT_WINDOW_MIN * 60_000),
      },
    },
    select: { conversationId: true },
  });
  if (holds.some((h) => h.conversationId === s.conversationId)) return "mine";
  if (holds.length > 0) return "taken";
  return "free";
}

export function checkSlot(s: SlotRef): Promise<SlotState> {
  return slotState(prisma, s);
}

/**
 * Ключ блокировки: один врач — одна очередь.
 *
 * Два ответа на статус обрабатываются одновременно в разных запросах. Без
 * блокировки оба прочитали бы «свободно» и оба закрепили бы окошко. Блокировка
 * транзакционная (pg_advisory_xact_lock): снимается сама с концом транзакции,
 * даже если процесс упадёт посередине.
 */
const FNV_OFFSET = BigInt("0xcbf29ce484222325");
const FNV_PRIME = BigInt("0x100000001b3");
const U64 = BigInt("0xffffffffffffffff");
const I64_MIN = BigInt("0x8000000000000000");
const U64_SPAN = BigInt("0x10000000000000000");

export function lockKey(companyId: string, staffId: string): bigint {
  // FNV-1a, 64 бита: стабильно и без зависимостей.
  let h = FNV_OFFSET;
  for (const ch of `${companyId}|${staffId}`) {
    h ^= BigInt(ch.codePointAt(0) ?? 0);
    h = (h * FNV_PRIME) & U64;
  }
  // В знаковый int8, который ждёт Postgres.
  return h >= I64_MIN ? h - U64_SPAN : h;
}

export type HoldResult = { kind: "held"; id: string } | { kind: Exclude<SlotState, "free"> } | { kind: "limit" };

/**
 * Закрепить окошко за диалогом.
 *
 * Проверка и закрепление — в одной транзакции под блокировкой врача: между
 * «свободно» и «закрепили» никто не вклинится. Передан `rowId` — закрепляем
 * уже обсуждавшийся вариант, иначе заводим новую строку.
 */
export async function holdSlot(
  s: SlotRef & { serviceId: string | null; statusText: string; statusExternalId: string | null; rowId?: string },
  now: Date = new Date(),
): Promise<HoldResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey(s.companyId, s.staffId)})`;

    const state = await slotState(tx, s);
    if (state !== "free") return { kind: state };

    const held = await tx.slotHold.count({
      where: { conversationId: s.conversationId, state: "HELD", startAt: { gt: now } },
    });
    if (held >= MAX_HELD) return { kind: "limit" as const };

    const data = {
      patientId: s.patientId,
      staffId: s.staffId,
      serviceId: s.serviceId,
      startAt: s.startAt,
      durationMin: s.durationMin,
      statusText: s.statusText.slice(0, 2000),
      statusExternalId: s.statusExternalId,
      state: "HELD",
      heldAt: now,
    };
    const row = s.rowId
      ? await tx.slotHold.update({ where: { id: s.rowId }, data, select: { id: true } })
      : await tx.slotHold.create({
          data: { companyId: s.companyId, conversationId: s.conversationId, ...data },
          select: { id: true },
        });
    return { kind: "held" as const, id: row.id };
  });
}

/**
 * Пациент передумал: другое время из того же статуса.
 *
 * Новое закрепляется и старое снимается в ОДНОЙ транзакции под той же
 * блокировкой врача: снять старое раньше значило бы на мгновение отдать его
 * другому, а закрепить новое, не сняв старое, — держать за человеком два окошка.
 */
export async function switchHold(
  held: OpenSlot & { companyId: string; conversationId: string; patientId: string | null },
  startAt: Date,
  now: Date = new Date(),
): Promise<HoldResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey(held.companyId, held.staffId)})`;
    const state = await slotState(
      tx,
      {
        companyId: held.companyId,
        conversationId: held.conversationId,
        patientId: held.patientId,
        staffId: held.staffId,
        startAt,
        durationMin: held.durationMin,
      },
      held.id,
    );
    if (state !== "free") return { kind: state };
    const row = await tx.slotHold.create({
      data: {
        companyId: held.companyId,
        conversationId: held.conversationId,
        patientId: held.patientId,
        staffId: held.staffId,
        serviceId: held.serviceId,
        startAt,
        durationMin: held.durationMin,
        statusText: held.statusText,
        statusExternalId: held.statusExternalId,
        state: "HELD",
        heldAt: now,
      },
      select: { id: true },
    });
    await tx.slotHold.update({ where: { id: held.id }, data: { state: "RELEASED" } });
    return { kind: "held" as const, id: row.id };
  });
}

// ───────────────────────────────────────── варианты диалога

export interface OpenSlot {
  id: string;
  staffId: string;
  serviceId: string | null;
  startAt: Date;
  durationMin: number;
  statusText: string;
  statusExternalId: string | null;
}

/** Незакрытые варианты диалога: будущие и не старше суток. */
export async function openSlots(conversationId: string, state: "CHOICE" | "OFFERED", now: Date = new Date()): Promise<OpenSlot[]> {
  return prisma.slotHold
    .findMany({
      where: {
        conversationId,
        state,
        startAt: { gt: now },
        createdAt: { gt: new Date(now.getTime() - OPEN_TTL_MS) },
      },
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        staffId: true,
        serviceId: true,
        startAt: true,
        durationMin: true,
        statusText: true,
        statusExternalId: true,
      },
    })
    .catch(() => []);
}

/**
 * Снять незакрытые варианты: пациент выбрал другое, ответил на новый статус
 * или отказался. Закреплённые не трогаем — их отпускает только время.
 */
export async function releaseOpen(conversationId: string, keepIds: string[] = []): Promise<void> {
  await prisma.slotHold
    .updateMany({
      where: { conversationId, state: { in: ["CHOICE", "OFFERED"] }, id: { notIn: keepIds } },
      data: { state: "RELEASED" },
    })
    .catch(() => {});
}

/** Завести варианты на выбор или одно предложенное окошко. */
export async function openSlotRows(
  input: {
    companyId: string;
    conversationId: string;
    patientId: string | null;
    state: "CHOICE" | "OFFERED";
    statusText: string;
    statusExternalId: string | null;
  },
  slots: { staffId: string; serviceId: string | null; startAt: Date; durationMin: number }[],
): Promise<void> {
  for (const s of slots) {
    await prisma.slotHold.create({
      data: {
        companyId: input.companyId,
        conversationId: input.conversationId,
        patientId: input.patientId,
        staffId: s.staffId,
        serviceId: s.serviceId,
        startAt: s.startAt,
        durationMin: s.durationMin,
        state: input.state,
        statusText: input.statusText.slice(0, 2000),
        statusExternalId: input.statusExternalId,
      },
    });
  }
}

/** Последнее закреплённое окошко диалога за сутки — пациент мог передумать. */
export async function recentHeld(conversationId: string, now: Date = new Date()): Promise<OpenSlot | null> {
  return prisma.slotHold
    .findFirst({
      where: {
        conversationId,
        state: "HELD",
        startAt: { gt: now },
        heldAt: { gt: new Date(now.getTime() - OPEN_TTL_MS) },
      },
      orderBy: { heldAt: "desc" },
      select: {
        id: true,
        staffId: true,
        serviceId: true,
        startAt: true,
        durationMin: true,
        statusText: true,
        statusExternalId: true,
      },
    })
    .catch(() => null);
}

/** Снять закрепление: пациент отказался или выбрал другое время. */
export async function releaseHeld(id: string): Promise<void> {
  await prisma.slotHold.update({ where: { id }, data: { state: "RELEASED" } }).catch(() => {});
}

/** Выбранный вариант становится предложенным: окошко свободно, ждём данные. */
export async function markOffered(id: string): Promise<void> {
  await prisma.slotHold.update({ where: { id }, data: { state: "OFFERED" } }).catch(() => {});
}

// ───────────────────────────────────────── кто пишет и на что

const childish = (title: string) => /(?<!\p{L})(дет[си]|ребен|ребён|подрост)/iu.test(title);

export interface SlotService {
  id: string;
  title: string;
  price: number;
  durationMin: number;
}

/**
 * Услуга окошка: то, что этот врач ведёт, для указанного возраста.
 *
 * Берём из визитов, как и везде: кто что ведёт, справочник знает сам. Только
 * однозначно: если подходит несколько услуг, цену не называем и длительность
 * берём по умолчанию — придуманная цена хуже никакой (§6.2).
 */
export async function serviceForSlot(
  companyId: string,
  staffId: string,
  audience: "child" | "adult" | null,
): Promise<SlotService | null> {
  const rows = await prisma.appointment
    .groupBy({
      by: ["primaryServiceId"],
      where: { companyId, staffId, deletedAt: null, primaryServiceId: { not: null } },
      _count: { _all: true },
    })
    .catch(() => []);
  const ids = rows.map((r) => r.primaryServiceId).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return null;
  const services = await prisma.service
    .findMany({
      where: { id: { in: ids }, companyId, isActive: true },
      select: { id: true, title: true, price: true, durationMin: true },
    })
    .catch(() => []);
  // Заготовки с нулевой и рублёвой ценой пациенту не называем (price-list).
  const real = services.filter((s) => Number(s.price) > 1);
  const fit = audience === null ? real : real.filter((s) => childish(s.title) === (audience === "child"));
  if (fit.length !== 1) return null;
  const s = fit[0];
  return { id: s.id, title: s.title, price: Number(s.price), durationMin: s.durationMin };
}

/**
 * Постоянный пациент записывает СЕБЯ — тогда данные не нужны.
 *
 * Так сказал заказчик: «если пациент уже ранее записывался и записывает себя,
 * то не спрашивать данные». Проверяем три вещи:
 *   1. карточка привязана к номеру и у неё есть записи (не отменённые);
 *   2. человек не говорит о другом — «запишите сына», «для мамы»;
 *   3. вид приёма в окошке совпадает с тем, на что он ходил: детское окошко и
 *      карточка только со взрослыми визитами — это ребёнок, которого в базе
 *      нет, и его данные нужны.
 */
export async function returningSelf(
  companyId: string,
  patientId: string | null,
  own: string,
  audience: "child" | "adult" | null,
): Promise<boolean> {
  if (!patientId || forSomeoneElse(own)) return false;
  const visits = await prisma.appointment
    .findMany({
      where: { companyId, patientId, deletedAt: null, status: { not: "CANCELLED" } },
      select: {
        primaryService: { select: { title: true } },
        services: { select: { service: { select: { title: true } } } },
      },
      take: 50,
    })
    .catch(() => []);
  if (visits.length === 0) return false;
  if (audience === null) return true;
  const titles = visits.flatMap((v) => [
    v.primaryService?.title ?? "",
    ...v.services.map((x) => x.service.title),
  ]).filter(Boolean);
  if (titles.length === 0) return false;
  return audience === "child" ? titles.some(childish) : titles.some((t) => !childish(t));
}

/** Запись для администратора в переписке — её видно в диалоге, и она не теряется среди уведомлений. */
export async function noteForAdmin(companyId: string, conversationId: string, body: string): Promise<void> {
  await prisma.dialogNote
    .create({ data: { companyId, conversationId, authorId: null, body: body.slice(0, 2000) } })
    .catch(() => {});
}
