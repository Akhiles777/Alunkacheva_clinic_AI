"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { normalizePhone } from "@/lib/phone";
import type { Appt } from "@/app/_data/store";
import type { AppointmentStatus } from "@/generated/prisma/enums";
import { todayRangeMoscow } from "@/lib/schedule";
import { clinicDayFor } from "@/lib/server/clinic-day";
import { pushAppointment, pushCancel, pushReschedule } from "@/lib/integrations/yclients/write-back";

/**
 * Расписание/«Сегодня» из ЕДИНОГО источника — проекции Appointment в БД (та же,
 * что читает отчёт владельца). Клиентский стор гидрируется отсюда и пишет сквозь
 * (write-through) с общими id, поэтому владелец, админ и врач видят одно и то же,
 * и данные переживают перезагрузку.
 */
/**
 * Кабинет базы → ключ, которым его знает интерфейс расписания.
 *
 * По порядковому номеру, а не по названию. Прежде ключ выводился из строки
 * «Кабинет 1…»: стоило клинике переименовать кабинет — и все его записи
 * уезжали в третий, потому что так работала последняя ветка условия.
 */
const ROOM_KEY = (sortOrder: number): string => `room-${sortOrder}`;

const TO_STORE: Record<string, Appt["status"]> = {
  ARRIVED: "arrived",
  NO_SHOW: "no_show",
  CONFIRMED: "confirmed",
  CREATED: "planned",
};
const TO_DB: Record<Appt["status"], AppointmentStatus> = {
  arrived: "ARRIVED",
  no_show: "NO_SHOW",
  confirmed: "CONFIRMED",
  planned: "CREATED",
};

function minuteOfDay(at: Date, tz = "Europe/Moscow"): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}
/** Москва — UTC+3 круглый год (без перехода), поэтому смещение фиксированное. */
function startAtFromMinute(startMinute: number): Date {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const hh = String(Math.floor(startMinute / 60)).padStart(2, "0");
  const mm = String(startMinute % 60).padStart(2, "0");
  return new Date(`${date}T${hh}:${mm}:00+03:00`);
}

export async function getAppointmentsForStore(): Promise<Appt[]> {
  const session = await getSession();
  const { start, end } = todayRangeMoscow();
  const rows = await prisma.appointment.findMany({
    where: {
      companyId: session.companyId,
      deletedAt: null,
      status: { not: "CANCELLED" },
      startAt: { gte: start, lt: end },
    },
    include: {
      staff: { select: { id: true, name: true } },
      room: { select: { name: true, sortOrder: true } },
      primaryService: { select: { title: true } },
      patient: { select: { name: true } },
    },
    orderBy: { startAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    /**
     * Без кабинета — значит без кабинета.
     *
     * Здесь стояла подстановка первого. Из YCLIENTS кабинеты не приходят
     * вовсе (у клиники они не заведены как ресурсы), и вся история визитов
     * складывалась в «Кабинет 1»: на главной он выглядел занятым до конца дня,
     * хотя ничего подобного не происходило. Придуманная занятость хуже
     * пустого места — по ней принимают решения.
     */
    roomId: r.room ? ROOM_KEY(r.room.sortOrder) : null,
    roomName: r.room?.name ?? "",
    doctor: r.staff.name,
    // Идентификатор специалиста: по имени отбирать нельзя, см. CurrentUser.staffId.
    staffId: r.staff.id,
    service: r.primaryService?.title ?? "",
    patientId: r.patientId,
    patientName: r.patient?.name ?? "",
    startMinute: minuteOfDay(r.startAt),
    durationMin: r.durationMin,
    status: TO_STORE[r.status] ?? "planned",
    isFirstVisit: r.isFirstVisit,
    price: Number(r.revenue),
    note: r.note,
    bookedByName: r.bookedByName,
  }));
}

/**
 * Записи за выбранный день.
 *
 * Стор держит только сегодняшний день — так и задумано: экраны про «сейчас».
 * Но в расписании можно открыть другой день недели, и подставлять туда
 * сегодняшние записи нельзя: это была бы неправда о чужом дне.
 */
export async function getAppointmentsForDay(dateIso: string): Promise<Appt[]> {
  const session = await getSession();
  const start = new Date(`${dateIso}T00:00:00+03:00`);
  if (Number.isNaN(start.getTime())) return [];
  const end = new Date(start.getTime() + 24 * 3600 * 1000);

  const rows = await prisma.appointment.findMany({
    where: {
      companyId: session.companyId,
      deletedAt: null,
      status: { not: "CANCELLED" },
      startAt: { gte: start, lt: end },
    },
    include: {
      staff: { select: { id: true, name: true } },
      room: { select: { name: true, sortOrder: true } },
      primaryService: { select: { title: true } },
      patient: { select: { name: true } },
    },
    orderBy: { startAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    roomId: r.room ? ROOM_KEY(r.room.sortOrder) : null,
    roomName: r.room?.name ?? "",
    doctor: r.staff.name,
    staffId: r.staff.id,
    service: r.primaryService?.title ?? "",
    patientId: r.patientId,
    patientName: r.patient?.name ?? "",
    startMinute: minuteOfDay(r.startAt),
    durationMin: r.durationMin,
    status: TO_STORE[r.status] ?? "planned",
    isFirstVisit: r.isFirstVisit,
    price: Number(r.revenue),
    note: r.note,
    bookedByName: r.bookedByName,
  }));
}

export interface WeekDay {
  /** «2026-08-18» — по нему открывается день. */
  date: string;
  /** «18 августа» — подпись для человека. */
  label: string;
  /** Записей на день, кроме отменённых. */
  count: number;
  /** Из них состоялись. */
  arrived: number;
  isToday: boolean;
}

/**
 * Неделя расписания: понедельник — воскресенье, с настоящими числами.
 *
 * Здесь стоял мок: даты «20–26 июля» и счётчики [4, 6, 5, 0, 7, 3, 0], зашитые
 * в код ещё до боевых данных. Четверг подставлял сегодняшнее число записей —
 * и полоса выглядела живой. Клиника видела чужую неделю июля и верила ей.
 */
export async function getScheduleWeek(): Promise<WeekDay[]> {
  const session = await getSession();
  const { start: todayStart } = todayRangeMoscow();

  // Понедельник текущей недели клиники.
  const dow = (new Date(todayStart.getTime() + 3 * 3600 * 1000).getUTCDay() + 6) % 7;
  const monday = new Date(todayStart.getTime() - dow * 24 * 3600 * 1000);
  const sunday = new Date(monday.getTime() + 7 * 24 * 3600 * 1000);

  const rows = await prisma.appointment.findMany({
    where: {
      companyId: session.companyId,
      deletedAt: null,
      status: { not: "CANCELLED" },
      startAt: { gte: monday, lt: sunday },
    },
    select: { startAt: true, status: true },
  });

  const key = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  const label = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
  });

  const todayKey = key(new Date());
  const days: WeekDay[] = [];
  for (let i = 0; i < 7; i++) {
    const at = new Date(monday.getTime() + i * 24 * 3600 * 1000);
    const k = key(at);
    const ofDay = rows.filter((r) => key(r.startAt) === k);
    days.push({
      date: k,
      label: label.format(at),
      count: ofDay.length,
      arrived: ofDay.filter((r) => r.status === "ARRIVED").length,
      isToday: k === todayKey,
    });
  }
  return days;
}

/**
 * Заметка по визиту: отзыв пациента, что пошло не так, на что обратить
 * внимание. Заполняет врач или администратор после приёма, читает ИИ-аналитик
 * владельца — поэтому текст живёт на визите, а не в свободном чате.
 */
export async function setApptNoteDb(id: string, note: string): Promise<void> {
  const session = await getSession();
  await prisma.appointment.updateMany({
    where: { id, companyId: session.companyId },
    data: { note: note.trim() || null },
  });
}

/**
 * Отметить исход визита.
 *
 * Вместе со статусом ведём выручку. Раньше отметка «пришёл» меняла только
 * статус: визит попадал в число пришедших с нулевой ценой, из-за чего выручка
 * не росла, а средний чек падал. Цену берём из услуги — ту же, что показана
 * в записи; уже проставленную вручную не трогаем.
 *
 * Неявка и отмена обнуляют выручку: денег по ним нет.
 */
export async function setApptStatusDb(id: string, status: Appt["status"]): Promise<void> {
  const session = await getSession();
  const row = await prisma.appointment.findFirst({
    where: { id, companyId: session.companyId },
    select: { revenue: true, primaryService: { select: { price: true } } },
  });
  if (!row) return;

  const current = Number(row.revenue);
  const servicePrice = Number(row.primaryService?.price ?? 0);
  const revenue =
    status === "arrived" ? (current > 0 ? current : servicePrice) : status === "no_show" ? 0 : current;

  await prisma.appointment.updateMany({
    where: { id, companyId: session.companyId },
    data: {
      status: TO_DB[status],
      attendanceRaw: status === "arrived" ? 1 : status === "no_show" ? -1 : null,
      revenue,
      paidAmount: status === "arrived" ? revenue : 0,
      isPaid: status === "arrived" && revenue > 0,
    },
  });
}

/**
 * Отменить визит.
 *
 * Отдельным действием, а не статусом: отмена освобождает слот и должна дойти
 * до YCLIENTS, иначе там время остаётся занятым и в него никого не поставят.
 */
export async function cancelApptDb(id: string): Promise<void> {
  const session = await getSession();
  await prisma.appointment.updateMany({
    where: { id, companyId: session.companyId },
    data: { status: "CANCELLED", cancelledAt: new Date(), revenue: 0, paidAmount: 0, isPaid: false },
  });
  await pushCancel(session.companyId, id).catch(() => {});
}

export async function rescheduleApptDb(id: string, startMinute: number): Promise<void> {
  const session = await getSession();
  const row = await prisma.appointment.findFirst({ where: { id, companyId: session.companyId }, select: { durationMin: true } });
  if (!row) return;
  const startAt = startAtFromMinute(startMinute);
  const endAt = new Date(startAt.getTime() + row.durationMin * 60_000);
  await prisma.appointment.updateMany({ where: { id, companyId: session.companyId }, data: { startAt, endAt, updatedAtYclients: startAt } });

  /**
   * Переносим и в YCLIENTS. Без этого визит там остаётся на старом времени:
   * старый слот числится занятым, новый — свободным, и администратор ставит
   * туда второго пациента. Сбой отправки не откатывает перенос — он записан,
   * а расхождение видно в состоянии визита и в сверке.
   */
  await pushReschedule(session.companyId, id).catch(() => {});
}

export interface CreateApptInput {
  id: string;
  roomId: string; // room-1/2/3
  doctor: string;
  /**
   * Специалист выбран явно в форме. Раньше его искали по первому слову имени
   * («Левин А. И.» → startsWith «Левин»), и два однофамильца отдали бы запись
   * не тому. Имя оставляем для показа, решение принимаем по id.
   */
  staffId?: string | null;
  service: string;
  patientId: string | null;
  patientName: string;
  startMinute: number;
  durationMin: number;
  status: Appt["status"];
  price?: number;
  note?: string | null;
  bookedByName?: string | null;
}

export async function createAppointmentDb(input: CreateApptInput): Promise<void> {
  const session = await getSession();
  const co = session.companyId;

  /**
   * Кабинет ищем по порядковому номеру — тем же ключом, каким его знает
   * интерфейс.
   *
   * Здесь стоял поиск по названию: `startsWith("Кабинет N")`. Стоит клинике
   * переименовать кабинет — «Процедурный», «Кабинет №1», что угодно, — и
   * поиск не находит ничего. А дальше запись молча не создавалась: на экране
   * она появлялась, в базе и в YCLIENTS её не было. Тихо потерянная запись —
   * это пациент, который придёт в незанятое для клиники время.
   */
  const roomSort = Number(input.roomId.replace("room-", ""));
  const [staff, room, service] = await Promise.all([
    input.staffId
      ? prisma.staff.findFirst({ where: { id: input.staffId, companyId: co, deletedAt: null }, select: { id: true } })
      : prisma.staff.findFirst({ where: { companyId: co, deletedAt: null, name: { startsWith: input.doctor.split(/\s/)[0] } }, select: { id: true } }),
    Number.isFinite(roomSort)
      ? prisma.room.findFirst({ where: { companyId: co, sortOrder: roomSort }, select: { id: true } })
      : Promise.resolve(null),
    input.service
      ? prisma.service.findFirst({ where: { companyId: co, title: input.service }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  // Без обязательных связей запись не создаём — и говорим об этом вслух.
  if (!staff) throw new Error(`Специалист «${input.doctor}» не найден в базе клиники`);
  if (!room) throw new Error(`Кабинет ${input.roomId} не найден в базе клиники`);

  // Пациент обязателен: находим по id/имени или заводим нового.
  let patientId = input.patientId;
  if (!patientId) {
    const found = await prisma.patient.findFirst({ where: { companyId: co, name: input.patientName.trim() }, select: { id: true } });
    patientId = found?.id ?? (await prisma.patient.create({ data: { companyId: co, name: input.patientName.trim(), firstSeenAt: new Date() } })).id;
  }

  /**
   * «Записывает другой человек»: родитель за ребёнка, супруг за супругу.
   * Если этот человек уже есть в базе (по телефону или по имени), связываем
   * карточки — тогда у ребёнка своя история визитов, а в карточке родителя
   * видно, кого он водит. Не нашли — остаётся просто подпись, кому звонить.
   */
  let bookedById: string | null = null;
  const bookedByRaw = input.bookedByName?.trim() ?? "";
  if (bookedByRaw) {
    const maybePhone = normalizePhone(bookedByRaw.replace(/[^\d+]/g, ""));
    const byPhone = maybePhone
      ? await prisma.patientPhone.findFirst({
          where: { companyId: co, phone: maybePhone },
          select: { patientId: true },
        })
      : null;
    const byName = byPhone
      ? null
      : await prisma.patient.findFirst({
          where: { companyId: co, deletedAt: null, name: bookedByRaw },
          select: { id: true },
        });
    bookedById = byPhone?.patientId ?? byName?.id ?? null;

    if (bookedById && bookedById !== patientId) {
      // Родство заводим один раз: повторная запись того же ребёнка не должна
      // плодить дубли связей.
      await prisma.patientRelation.upsert({
        where: {
          patientId_relatedPatientId_kind: {
            patientId: bookedById,
            relatedPatientId: patientId,
            kind: "PARENT",
          },
        },
        update: {},
        create: { companyId: co, patientId: bookedById, relatedPatientId: patientId, kind: "PARENT" },
      });
    }
  }

  const startAt = startAtFromMinute(input.startMinute);
  const endAt = new Date(startAt.getTime() + input.durationMin * 60_000);
  await prisma.appointment.create({
    data: {
      id: input.id,
      companyId: co,
      // Номер записи проставит YCLIENTS при отправке; случайный локальный
      // номер столкнулся бы с настоящим при выгрузке и перезаписал чужой визит.
      yclientsRecordId: null,
      bookedByName: input.bookedByName?.trim() || null,
      bookedByPatientId: bookedById,
      patientId,
      staffId: staff.id,
      roomId: room.id,
      primaryServiceId: service?.id ?? null,
      startAt,
      endAt,
      durationMin: input.durationMin,
      status: TO_DB[input.status],
      isFirstVisit: false,
      // Цена визита — из формы (по умолчанию цена услуги из настроек).
      revenue: input.price ?? 0,
      note: input.note?.trim() || null,
      createdAtYclients: startAt,
      updatedAtYclients: startAt,
      // Ждёт отправки в YCLIENTS. Пока интеграция выключена, отправка сразу
      // вернёт «локальный визит» и пометит его честно.
      syncState: "PENDING",
    },
  });

  /**
   * Отправляем сразу, не дожидаясь синхронизации: администратор должен
   * увидеть конфликт слота сейчас, а не через час. Ошибка отправки не должна
   * ронять создание — визит у нас уже есть, состояние отправки записано.
   */
  await pushAppointment(co, input.id).catch(() => {});
}

// ─────────────────────────────────────────────── справочники для формы записи

/**
 * Пациент для формы записи. Раньше имя вводилось текстом и запись уходила
 * с patientId = null: одноимённые люди сливались в одного, а опечатка в
 * фамилии заводила ещё одну карточку. Теперь администратор выбирает человека
 * из базы, а завести нового по-прежнему можно — просто это отдельное решение.
 */
export interface PatientOption {
  id: string;
  name: string;
  phone: string | null;
  /** Сколько визитов уже было — помогает отличить тёзок. */
  visits: number;
}

export async function searchPatientsForBooking(query: string): Promise<PatientOption[]> {
  const session = await getSession();
  const q = query.trim();
  const digits = q.replace(/\D/g, "");

  const rows = await prisma.patient.findMany({
    where: {
      companyId: session.companyId,
      deletedAt: null,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" as const } },
              ...(digits.length >= 3
                ? [{ phones: { some: { phone: { contains: digits } } } }]
                : []),
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: {
      id: true,
      name: true,
      phones: { where: { isPrimary: true }, select: { phone: true }, take: 1 },
      _count: { select: { appointments: true } },
    },
  });

  return rows.map((p) => ({
    id: p.id,
    name: p.name ?? "Без имени",
    phone: p.phones[0]?.phone ?? null,
    visits: p._count.appointments,
  }));
}

/** Специалист для формы записи: список живой, из базы, а не зашитый в код. */
export interface SpecialistOption {
  id: string;
  name: string;
  specialty: string | null;
  /** Кабинет по умолчанию — им подставляем специалиста под выбранную услугу. */
  roomKey: string | null;
}

export async function getSpecialistsForBooking(): Promise<SpecialistOption[]> {
  const session = await getSession();
  const rows = await prisma.staff.findMany({
    where: { companyId: session.companyId, deletedAt: null, isActive: true },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      name: true,
      specialty: true,
      defaultRoom: { select: { name: true, sortOrder: true } },
    },
  });
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    specialty: s.specialty,
    roomKey: s.defaultRoom ? ROOM_KEY(s.defaultRoom.sortOrder) : null,
  }));
}

/**
 * Услуги для формы записи — из настроек клиники, а не из списка в коде.
 *
 * Пять услуг были записаны прямо в компоненте вместе с врачами и кабинетами.
 * Клиника завела восемь — три просто не появлялись в форме, а изменение цены
 * или длительности в настройках на запись не влияло.
 *
 * Кабинет берём первый из привязанных: по нему считаются свободные окна.
 * Услуга без кабинета возвращается с roomKey = null — форма честно скажет,
 * что окна посчитать не из чего, вместо того чтобы подставить чужой кабинет.
 */
export interface ServiceOption {
  id: string;
  title: string;
  durationMin: number;
  price: number;
  roomKey: string | null;
  roomName: string | null;
}

export async function getServicesForBooking(): Promise<ServiceOption[]> {
  const session = await getSession();
  const rows = await prisma.service.findMany({
    where: { companyId: session.companyId, isActive: true },
    orderBy: { title: "asc" },
    select: {
      id: true,
      title: true,
      durationMin: true,
      price: true,
      rooms: {
        select: { room: { select: { name: true, sortOrder: true } } },
      },
    },
  });

  return rows.map((s) => {
    const room = [...s.rooms].sort((a, b) => a.room.sortOrder - b.room.sortOrder)[0]?.room ?? null;
    return {
      id: s.id,
      title: s.title,
      durationMin: s.durationMin,
      price: Number(s.price),
      roomKey: room ? ROOM_KEY(room.sortOrder) : null,
      roomName: room?.name ?? null,
    };
  });
}

/**
 * Рабочее окно клиники на сегодня с учётом исключений.
 *
 * Нужно и форме записи, и экрану «Сегодня»: в праздник свободных окон быть
 * не должно, в укороченный день их меньше. Раньше и там и там стояло
 * жёсткое 9:00–21:00, поэтому исключения ни на что не влияли.
 */
export interface ClinicDayView {
  closed: boolean;
  startMinute: number;
  endMinute: number;
  label: string | null;
  /** Кабинеты клиники — настоящие, а не зашитые в коде. */
  rooms: {
    id: string;
    name: string;
    direction: string;
    /** Кто закреплён за кабинетом — все, а не один. */
    staff: string[];
  }[];
}

export async function getClinicDayToday(): Promise<ClinicDayView> {
  const session = await getSession();
  const [day, rooms] = await Promise.all([
    clinicDayFor(session.companyId, new Date()),
    /**
     * Кабинеты — настоящие, из базы клиники.
     *
     * Экран «Сегодня» показывал их по списку, зашитому в коде: «Кабинет 1 ·
     * Процедурный · IV», «Кабинет 2 · БОС-терапия». У клиники названия другие,
     * и совпадали они только по номеру — то есть по случайности. Всё, что
     * связано с кабинетами, должно приходить из одного места.
     */
    prisma.room.findMany({
      where: { companyId: session.companyId, isActive: true },
      orderBy: { sortOrder: "asc" },
      select: {
        name: true,
        sortOrder: true,
        direction: true,
        /**
         * Все закреплённые за кабинетом, а не один.
         *
         * В процедурном работают две медсестры — Сафия Гаджиевна и Нурият, —
         * а карточка показывала одну: имя бралось у того, у кого сегодня
         * больше приёмов. Кто закреплён за кабинетом, знает база, и спрашивать
         * об этом расписание одного дня не нужно.
         */
        defaultForStaff: {
          where: { isActive: true, deletedAt: null },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: { name: true },
        },
      },
    }),
  ]);
  return {
    closed: day.window === null,
    startMinute: day.window?.startMinute ?? 0,
    endMinute: day.window?.endMinute ?? 0,
    label: day.label,
    rooms: rooms.map((r) => ({
      id: ROOM_KEY(r.sortOrder),
      name: r.name,
      // Направление клиника заполняет в настройках; если поле пустое — берём
      // то, что написано в названии после тире.
      direction: r.direction?.trim() || r.name.split(/\s+[—–-]\s+/)[1] || "",
      staff: r.defaultForStaff.map((s) => s.name),
    })),
  };
}
