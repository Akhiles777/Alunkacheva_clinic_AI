import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runFastCycle, runSyncCycle, schedulerState } from "@/lib/server/scheduler";

/**
 * Синхронизация с YCLIENTS по расписанию.
 *
 * До сих пор выгрузка запускалась только кнопкой в настройках. Значит статусы
 * визитов обновлялись ровно тогда, когда кто-то вспоминал нажать кнопку, — а
 * администратор отмечает «пришёл» каждый день. В отчётах это выглядело как
 * «приёмов шестнадцать, пришёл один»: приёмы приехали с выгрузкой, отметки о
 * посещении — нет.
 *
 * Своего планировщика у приложения нет (§3 предполагал воркеры на BullMQ, но
 * на сервере их не разворачивали), поэтому вызывать этот адрес должен
 * системный cron. Строка для crontab — в .env.example рядом с секретом.
 *
 * Адрес закрыт секретом: без него любой желающий мог бы запускать выгрузку и
 * упереть клинику в лимит запросов YCLIENTS.
 */

export const runtime = "nodejs";
/** Полная выгрузка длинная: месячные окна за несколько лет. */
export const maxDuration = 800;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

/**
 * Состояние без запуска выгрузки: `?check=1`.
 *
 * Нужно, чтобы проверить данные, не заходя на сервер по ssh. Раньше любая
 * проверка требовала пароля и запуска скрипта руками, и вопрос «почему цифры
 * не обновились» упирался в переписку вместо ответа.
 *
 * Только чтение и только числа: ни имён, ни телефонов (§7).
 */
async function state(): Promise<Response> {
  const company = await prisma.company.findFirst({
    where: { yclientsId: { gte: 100 } },
    select: { id: true, name: true },
  });
  if (!company) return NextResponse.json({ ok: true, note: "нет клиник, привязанных к YCLIENTS" });

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [cursors, byStatus, patients, newExact, newInexact, withRoom, withoutRoom, zeroRevenue, hooks] =
    await Promise.all([
      prisma.syncCursor.findMany({
        where: { companyId: company.id },
        select: { entity: true, lastSyncedAt: true },
        orderBy: { entity: "asc" },
      }),
      prisma.appointment.groupBy({
        by: ["status"],
        where: { companyId: company.id, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.patient.count({ where: { companyId: company.id, deletedAt: null } }),
      prisma.patient.count({
        where: {
          companyId: company.id,
          deletedAt: null,
          firstSeenExact: true,
          firstSeenAt: { gte: monthStart },
        },
      }),
      prisma.patient.count({
        where: { companyId: company.id, deletedAt: null, firstSeenExact: false },
      }),
      prisma.appointment.count({
        where: { companyId: company.id, deletedAt: null, roomId: { not: null } },
      }),
      prisma.appointment.count({
        where: { companyId: company.id, deletedAt: null, roomId: null },
      }),
      prisma.appointment.count({
        where: { companyId: company.id, deletedAt: null, status: "ARRIVED", revenue: 0 },
      }),
      prisma.webhookEvent.count({ where: { companyId: company.id, provider: "YCLIENTS" } }),
    ]);

  /**
   * Разбивка по кабинетам и то, чего не хватает для привязки.
   *
   * «Процедурный кабинет 0% — не может такого быть» — и это правда: приёмы в
   * нём идут каждый день. Ноль означает не отсутствие приёмов, а отсутствие
   * привязки: кабинет визита берётся из ресурса YCLIENTS (их клиника не
   * ведёт), из кабинета специалиста или из кабинета услуги. Нет ни одного —
   * визит остаётся без кабинета и в загрузку не попадает.
   *
   * Печатаем, у каких услуг и специалистов привязки нет: по этому списку
   * видно, что именно заполнить.
   */
  const [rooms, byRoom, staffNoRoom, servicesNoRoom, servicesTotal, servicesFromYclients, prices] =
    await Promise.all([
    prisma.room.findMany({
      where: { companyId: company.id, isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true },
    }),
    prisma.appointment.groupBy({
      by: ["roomId"],
      where: { companyId: company.id, deletedAt: null },
      _count: { _all: true },
    }),
    /**
     * Все специалисты, включая выключенных.
     *
     * Заказчик заметил, что медсестёр двое — Сафия Гаджиевна и Нурият, — а в
     * списке видна одна. Показываем всех: выключенный в YCLIENTS специалист у
     * нас не исчезает, но и в загрузку кабинетов не попадает, и это надо
     * видеть, а не выяснять.
     */
    prisma.staff.findMany({
      where: { companyId: company.id, deletedAt: null },
      select: {
        name: true,
        specialty: true,
        isActive: true,
        defaultRoom: { select: { name: true } },
        _count: { select: { appointments: { where: { deletedAt: null } } } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.service.findMany({
      where: { companyId: company.id, rooms: { none: {} }, isActive: true },
      select: { title: true },
      take: 30,
    }),
    prisma.service.count({ where: { companyId: company.id } }),
    prisma.service.count({ where: { companyId: company.id, yclientsServiceId: { not: null } } }),
    /**
     * Цены услуг — то, чем отвечает ассистент пациенту.
     *
     * На живом диалоге женщина записывала ребёнка, а услышала 8000 ₽. Понять,
     * ошибка это модели или цена в справочнике, можно только увидев сам
     * справочник. Это данные клиники, не пациентов: показывать их безопасно.
     */
    prisma.service.findMany({
      where: { companyId: company.id, isActive: true },
      select: { title: true, price: true, durationMin: true },
      orderBy: { title: "asc" },
    }),
  ]);
  const countByRoom = new Map(byRoom.map((r) => [r.roomId, r._count._all]));

  return NextResponse.json({
    ok: true,
    at: now.toISOString(),
    company: company.name,
    расписание: schedulerState(),
    визитыПоКабинетам: [
      ...rooms.map((r) => ({ кабинет: r.name, визитов: countByRoom.get(r.id) ?? 0 })),
      { кабинет: "(без кабинета)", визитов: countByRoom.get(null) ?? 0 },
    ],
    ктоВКакомКабинете: staffNoRoom.map(
      (s) =>
        `${s.name}${s.specialty ? ` (${s.specialty})` : ""} → ` +
        `${s.defaultRoom?.name ?? "КАБИНЕТ НЕ ЗАДАН"}` +
        `${s.isActive ? "" : " · выключен"}, визитов ${s._count.appointments}`,
    ),
    услугиБезКабинета: servicesNoRoom.map((s) => s.title),
    ценыУслуг: prices.map((s) => `${s.title} — ${Number(s.price)} ₽, ${s.durationMin} мин`),
    /**
     * Задвоенные услуги. Одна строка заведена руками и несёт привязку к
     * кабинету, вторая приехала из YCLIENTS и на неё ссылаются визиты — из-за
     * этого кабинет у визита не находится. См. scripts/services-dedupe.ts.
     */
    услуги: {
      всего: servicesTotal,
      изYclients: servicesFromYclients,
      заведеныУНас: servicesTotal - servicesFromYclients,
    },
    синхронизация: Object.fromEntries(
      cursors.map((c) => [c.entity, c.lastSyncedAt?.toISOString() ?? null]),
    ),
    визиты: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    кабинеты: { сУказанным: withRoom, безКабинета: withoutRoom },
    выручка: { состоявшихсяСНулём: zeroRevenue },
    пациенты: { всего: patients, новыхВЭтомМесяце: newExact, датаНеизвестна: newInexact },
    вебхукиYclients: hooks,
  });
}

/**
 * Полный круг снаружи — тем же путём, что и по расписанию.
 *
 * Раньше этот адрес вёл свою копию цикла: свой обход клиник, свой пересчёт, но
 * без возврата диалогов и добора неотвеченных. Пока расписания в приложении не
 * было, разницы не было тоже; теперь она есть — системный cron мог войти в
 * выгрузку ровно тогда, когда её уже вела внутренняя, и обе спрашивали
 * YCLIENTS про одни и те же дни. Замок один на процесс, поэтому идём через
 * него, а «уже идёт» — честный ответ, а не ошибка.
 */
async function run(): Promise<Response> {
  const info = await runSyncCycle();
  return NextResponse.json({ ok: info.ok, at: new Date().toISOString(), круг: info });
}

/**
 * Что делать по этому обращению.
 *
 * `?check=1` — только состояние. `?fast=1` — короткий круг: свежие записи за
 * пару дней и месяц вперёд, без справочников и кассы. Полное расписание живёт
 * внутри приложения, но короткий круг доступен и снаружи: когда нужно увидеть
 * запись сейчас, а не через три минуты.
 */
async function dispatch(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  if (q.get("check")) return state();
  if (q.get("fast")) return NextResponse.json({ ok: true, короткийКруг: await runFastCycle() });
  return run();
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "нужен CRON_SECRET" }, { status: 401 });
  }
  return dispatch(req);
}

/** GET — чтобы запускать той же строкой curl из crontab. */
export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "нужен CRON_SECRET" }, { status: 401 });
  }
  return dispatch(req);
}
