"use server";

import { prisma } from "@/lib/db";
import { startOfClinicDay } from "@/lib/clinic-time";
import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import { normalizePhone } from "@/lib/phone";
import type { PatientNoteKind, PatientRelationKind } from "@/generated/prisma/enums";

/**
 * Пациенты в БД (§4): идентичность, телефоны (E.164), заметки, родственные связи.
 * Клиентский стор гидрируется отсюда при загрузке и пишет сюда сквозь (write-
 * through) с общими id, поэтому пациенты переживают перезагрузку и остаются
 * единым источником правды для всех экранов. Удаление — мягкое.
 *
 * Курсы/визиты/переписка мигрируют вместе со своими подсистемами (Course,
 * Appointment, Message) — здесь их нет.
 */
/** Визит в карточке пациента. */
export interface PatientVisitRecord {
  id: string;
  /** Дата в виде «12 марта 2026 г.» — её читает человек. */
  date: string;
  /**
   * Та же дата машинным форматом.
   *
   * Аналитика карточки прежде разбирала русскую подпись обратно в дату и
   * спотыкалась о суффикс «г.»: визиты не разбирались, и панель показывала
   * «0 из 7», прочерк в среднем интервале и в последнем визите при полной
   * истории на экране. Дату нельзя передавать текстом и восстанавливать
   * разбором — она передаётся как дата.
   */
  at: string;
  service: string;
  doctor: string;
  status: "arrived" | "no_show" | "cancelled" | "planned";
  amount: number;
  /**
   * Откуда взялась сумма.
   *
   * Ноль без пояснения читается как «не заполнили», и администратор идёт
   * искать цену. На деле ноль бывает настоящим: услугу отдали бесплатно по
   * скидке или акции. Разные вещи должны выглядеть по-разному.
   */
  amountSource: "RECORD" | "PRICE_LIST" | "PREPAID" | "FREE" | "UNKNOWN";
}

export interface PatientRecord {
  id: string;
  name: string;
  source: string | null;
  firstSeenToday: boolean;
  /** Дата первого обращения. В карточке показывается дата, а не только «ранее». */
  firstSeenAt: string;
  /**
   * Где пациент в своём пути: ещё не приходил, пришёл впервые, ходит дальше.
   *
   * Считается по состоявшимся визитам (§8), а не по дате контакта. Прежде
   * метка ставилась по «первый контакт сегодня» — и у всех, кто пришёл не
   * сегодня, её не было вовсе: ни «первичный», ни «повторный», пустое место.
   */
  visitStage: "new" | "primary" | "repeat";
  phones: { id: string; e164: string; label: string | null; isPrimary: boolean; whatsapp: boolean }[];
  notes: { id: string; kind: PatientNoteKind; text: string; resolved: boolean }[];
  relations: { id: string; relatedPatientId: string; kind: PatientRelationKind }[];
  /**
   * История визитов. Заполняется только при открытии карточки: в списке
   * пациентов она не нужна, а тянуть её на всю базу — лишние тысячи строк.
   *
   * Раньше карточка показывала пустую историю всегда: поле в сторе стояло
   * пустым массивом, и ни один запрос его не наполнял. Сколько бы визитов ни
   * выгрузили из YCLIENTS, в карточке было «визитов нет».
   */
  visits?: PatientVisitRecord[];
}

/** Статус визита в базе → как его понимает карточка. */
const VISIT_STATUS_MAP: Record<string, PatientVisitRecord["status"]> = {
  ARRIVED: "arrived",
  NO_SHOW: "no_show",
  CANCELLED: "cancelled",
  CREATED: "planned",
  CONFIRMED: "planned",
};

/**
 * Метка пути пациента по числу состоявшихся визитов (§8).
 *
 * Ноль — обратился, но ещё не приходил. Один — тот самый первичный визит.
 * Больше — повторный. Прежде метка ставилась по дате первого контакта, и у
 * всех, кто пришёл не сегодня, её не было вовсе.
 */
function stageOf(arrived: number): "new" | "primary" | "repeat" {
  if (arrived === 0) return "new";
  return arrived === 1 ? "primary" : "repeat";
}

const visitDate = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Moscow",
});

/**
 * Ограничение выборки для тех, кому не выдано право видеть чужих пациентов.
 *
 * Право настраивается по каждому сотруднику, но выборка его не спрашивала:
 * врач получал всю базу клиники целиком, включая пациентов, которых никогда
 * не вёл. Для медицинских данных это прямое нарушение §7 — доступ должен быть
 * ролевым, а просмотр карточки фиксироваться в аудите.
 *
 * Без права сотрудник видит только тех, у кого есть визит к нему. Не привязан
 * к специалисту — не видит никого: это честнее, чем показать всех.
 */
async function patientScope(session: {
  companyId: string;
  userId: string | null;
  role: Parameters<typeof can>[0]["role"];
}): Promise<{ appointments?: { some: { staffId: string } } } | null> {
  if (await can(session, "VIEW_OTHER_PATIENTS")) return {};
  const user = session.userId
    ? await prisma.staffUser.findUnique({
        where: { id: session.userId },
        select: { staffId: true },
      })
    : null;
  if (!user?.staffId) return null;
  return { appointments: { some: { staffId: user.staffId } } };
}

export async function getPatientRecords(): Promise<PatientRecord[]> {
  const session = await getSession();
  const scope = await patientScope(session);
  if (!scope) return [];
  const patients = await prisma.patient.findMany({
    where: { companyId: session.companyId, deletedAt: null, ...scope },
    orderBy: { createdAt: "asc" },
    include: {
      source: { select: { title: true } },
      phones: { orderBy: { createdAt: "asc" } },
      notes: { orderBy: { createdAt: "asc" } },
      relationsOut: true,
      // Состоявшиеся визиты: по ним ставится метка «первичный/повторный».
      _count: { select: { appointments: { where: { status: "ARRIVED", deletedAt: null } } } },
    },
  });
  // Полночь клиники, а не сервера: на UTC-хостинге «сегодня» начиналось в 03:00.
  const startOfToday = startOfClinicDay();
  return patients.map((p) => ({
    id: p.id,
    name: p.name ?? "",
    source: p.source?.title ?? null,
    firstSeenToday: p.firstSeenAt >= startOfToday,
    firstSeenAt: p.firstSeenAt.toISOString(),
    visitStage: stageOf(p._count.appointments),
    phones: p.phones.map((ph) => ({
      id: ph.id,
      e164: ph.phone,
      label: ph.label,
      isPrimary: ph.isPrimary,
      whatsapp: ph.usedForWhatsapp,
    })),
    notes: p.notes.map((n) => ({
      id: n.id,
      kind: n.kind,
      text: n.text,
      resolved: n.resolvedAt !== null,
    })),
    relations: p.relationsOut.map((r) => ({
      id: r.id,
      relatedPatientId: r.relatedPatientId,
      kind: r.kind,
    })),
  }));
}

/**
 * Одна карточка по идентификатору.
 *
 * Клиентский стор наполняется один раз при загрузке дашборда, поэтому пациент,
 * заведённый после — из диалога, ботом или выгрузкой YCLIENTS, — в нём
 * отсутствует, и карточка открывалась с надписью «пациент не найден». Экран
 * догружает её этим действием.
 */
export async function getPatientRecord(id: string): Promise<PatientRecord | null> {
  const session = await getSession();
  const scope = await patientScope(session);
  if (!scope) return null;

  const p = await prisma.patient.findFirst({
    where: { id, companyId: session.companyId, deletedAt: null, ...scope },
    include: {
      source: { select: { title: true } },
      phones: { orderBy: { createdAt: "asc" } },
      notes: { orderBy: { createdAt: "asc" } },
      relationsOut: true,
      _count: { select: { appointments: { where: { status: "ARRIVED", deletedAt: null } } } },
      appointments: {
        where: { deletedAt: null },
        orderBy: { startAt: "desc" },
        // История в карточке нужна обозримая: у постоянного пациента их сотни.
        take: 100,
        select: {
          id: true,
          startAt: true,
          status: true,
          revenue: true,
          revenueSource: true,
          isPaid: true,
          courseSessionIndex: true,
          course: { select: { sessionsTotal: true } },
          staff: { select: { name: true } },
          primaryService: { select: { title: true } },
        },
      },
    },
  });
  if (!p) return null;

  // Полночь клиники, а не сервера: на UTC-хостинге «сегодня» начиналось в 03:00.
  const startOfToday = startOfClinicDay();
  return {
    id: p.id,
    name: p.name ?? "",
    source: p.source?.title ?? null,
    firstSeenToday: p.firstSeenAt >= startOfToday,
    firstSeenAt: p.firstSeenAt.toISOString(),
    visitStage: stageOf(p._count.appointments),
    phones: p.phones.map((ph) => ({
      id: ph.id,
      e164: ph.phone,
      label: ph.label,
      isPrimary: ph.isPrimary,
      whatsapp: ph.usedForWhatsapp,
    })),
    notes: p.notes.map((n) => ({ id: n.id, kind: n.kind, text: n.text, resolved: n.resolvedAt !== null })),
    relations: p.relationsOut.map((r) => ({
      id: r.id,
      relatedPatientId: r.relatedPatientId,
      kind: r.kind,
    })),
    visits: p.appointments.map((a) => ({
      id: a.id,
      date: visitDate.format(a.startAt),
      at: a.startAt.toISOString(),
      service: a.primaryService?.title ?? "—",
      doctor: a.staff?.name ?? "—",
      status: VISIT_STATUS_MAP[a.status] ?? "planned",
      amount: Number(a.revenue),
      amountSource: a.revenueSource,
      /**
       * Деньги по визиту приняты, хотя в записи дня стоит ноль.
       *
       * YCLIENTS помечает такой сеанс `paid_full`: стоимость услуги известна,
       * оплата прошла раньше — при продаже курса. Без этого признака сеанс
       * курса и приём, за который клиника денег не брала, выглядят одинаково.
       */
      paidEarlier: a.isPaid,
      /**
       * Номер сеанса в курсе — то, что администратор называет пациенту вслух.
       * Без него у сеанса курса в карточке стоял необъяснимый ноль.
       */
      courseSession:
        a.courseSessionIndex && a.course
          ? { index: a.courseSessionIndex, total: a.course.sessionsTotal }
          : null,
    })),
  };
}

async function sourceIdByTitle(companyId: string, title: string | null | undefined) {
  if (!title) return null;
  const s = await prisma.source.findFirst({ where: { companyId, title }, select: { id: true } });
  return s?.id ?? null;
}

export async function createPatient(input: {
  id: string;
  name: string;
  source?: string | null;
  phoneId?: string;
  e164?: string | null;
}): Promise<void> {
  const session = await getSession();
  const sourceId = await sourceIdByTitle(session.companyId, input.source);

  /**
   * Телефон нормализуем на сервере (§4). Раньше это делал только экран, а
   * сервер принимал присланное как есть: «+7 (999) 123-45-67» и
   * «+79991234567» ложились как разные номера, и ни уникальность, ни
   * сопоставление пациентов уже не работали.
   */
  const phoneE164 = input.e164 ? normalizePhone(input.e164) : null;
  if (input.e164 && !phoneE164) throw new Error("Не удалось разобрать номер телефона");
  if (phoneE164) {
    const taken = await prisma.patientPhone.findFirst({
      where: { companyId: session.companyId, phone: phoneE164 },
      select: { patient: { select: { name: true } } },
    });
    if (taken) {
      throw new Error(
        `Этот номер уже записан на пациента «${taken.patient?.name ?? "без имени"}».`,
      );
    }
  }

  await prisma.patient.create({
    data: {
      id: input.id,
      companyId: session.companyId,
      name: input.name.trim(),
      firstSeenAt: new Date(),
      sourceId,
      phones:
        phoneE164 && input.phoneId
          ? { create: { id: input.phoneId, companyId: session.companyId, phone: phoneE164, isPrimary: true } }
          : undefined,
    },
  });
}

export async function updatePatientDb(id: string, patch: { name?: string; source?: string | null }): Promise<void> {
  const session = await getSession();
  const data: { name?: string; sourceId?: string | null } = {};
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.source !== undefined) data.sourceId = await sourceIdByTitle(session.companyId, patch.source);
  await prisma.patient.updateMany({ where: { id, companyId: session.companyId }, data });
}

/**
 * Удаление карточки пациента.
 *
 * Сама карточка удаляется мягко (§4): визиты, переписка и выгрузка из
 * YCLIENTS на неё ссылаются, и физическое удаление порвало бы историю.
 *
 * Но две вещи нужно отвязать по-настоящему.
 *
 * Диалоги. Переписка живёт дальше — человек продолжает писать в WhatsApp. Если
 * оставить ссылку на удалённую карточку, диалог выглядит привязанным, а
 * «Карточка клиента» открывает пустоту: карточки-то нет. Так и вышло после
 * удаления дубля с неверным номером. Отвязываем — администратор привяжет
 * диалог к правильной карточке, и кнопка снова работает.
 *
 * Телефоны. Номер уникален в пределах клиники (§4), и пока он числится за
 * удалённой карточкой, добавить его к правильной нельзя — «номер занят». Хуже
 * того, сопоставление по номеру приводило бы новые обращения к удалённой
 * карточке. Номер — не медицинская тайна и не история визитов; освобождаем.
 */
export async function softDeletePatient(id: string): Promise<void> {
  const session = await getSession();
  await prisma.$transaction([
    prisma.patient.updateMany({
      where: { id, companyId: session.companyId },
      data: { deletedAt: new Date() },
    }),
    prisma.conversation.updateMany({
      where: { patientId: id, companyId: session.companyId },
      data: { patientId: null },
    }),
    prisma.patientPhone.deleteMany({ where: { patientId: id, companyId: session.companyId } }),
  ]);
}

export async function addPhoneDb(input: {
  id: string;
  patientId: string;
  e164: string;
  isPrimary: boolean;
}): Promise<void> {
  const session = await getSession();

  const e164 = normalizePhone(input.e164);
  if (!e164) throw new Error("Не удалось разобрать номер телефона");

  /**
   * Номер принадлежит ровно одному пациенту (§4): по телефону мы сопоставляем
   * людей, и один номер на двух карточках означает, что визиты и переписка
   * начнут распределяться между ними произвольно. Проверяем заранее, чтобы
   * показать понятную причину вместо ошибки базы.
   */
  const taken = await prisma.patientPhone.findFirst({
    where: { companyId: session.companyId, phone: e164 },
    select: { patientId: true, patient: { select: { name: true } } },
  });
  if (taken) {
    if (taken.patientId === input.patientId) return;
    throw new Error(
      `Этот номер уже записан на пациента «${taken.patient?.name ?? "без имени"}». ` +
        "Один номер может принадлежать только одному человеку.",
    );
  }

  await prisma.patientPhone.create({
    data: {
      id: input.id,
      companyId: session.companyId,
      patientId: input.patientId,
      phone: e164,
      isPrimary: input.isPrimary,
    },
  });
}

export async function removePhoneDb(phoneId: string, newPrimaryId: string | null): Promise<void> {
  const session = await getSession();
  await prisma.patientPhone.deleteMany({ where: { id: phoneId, companyId: session.companyId } });
  if (newPrimaryId) {
    await prisma.patientPhone.updateMany({
      where: { id: newPrimaryId, companyId: session.companyId },
      data: { isPrimary: true },
    });
  }
}

export async function setPrimaryPhoneDb(patientId: string, phoneId: string): Promise<void> {
  const session = await getSession();
  await prisma.$transaction([
    prisma.patientPhone.updateMany({
      where: { patientId, companyId: session.companyId },
      data: { isPrimary: false },
    }),
    prisma.patientPhone.updateMany({
      where: { id: phoneId, companyId: session.companyId },
      data: { isPrimary: true },
    }),
  ]);
}

export async function toggleWhatsappDb(phoneId: string, value: boolean): Promise<void> {
  const session = await getSession();
  await prisma.patientPhone.updateMany({
    where: { id: phoneId, companyId: session.companyId },
    data: { usedForWhatsapp: value },
  });
}

export async function addNoteDb(input: {
  id: string;
  patientId: string;
  kind: PatientNoteKind;
  text: string;
}): Promise<void> {
  const session = await getSession();
  await prisma.patientNote.create({
    data: {
      id: input.id,
      companyId: session.companyId,
      patientId: input.patientId,
      kind: input.kind,
      text: input.text.trim(),
    },
  });
}

export async function resolveNoteDb(noteId: string): Promise<void> {
  const session = await getSession();
  await prisma.patientNote.updateMany({
    where: { id: noteId, companyId: session.companyId },
    data: { resolvedAt: new Date() },
  });
}

export async function addRelationDb(input: {
  id: string;
  patientId: string;
  relatedPatientId: string;
  kind: PatientRelationKind;
}): Promise<void> {
  const session = await getSession();
  await prisma.patientRelation.upsert({
    where: {
      patientId_relatedPatientId_kind: {
        patientId: input.patientId,
        relatedPatientId: input.relatedPatientId,
        kind: input.kind,
      },
    },
    update: {},
    create: {
      id: input.id,
      companyId: session.companyId,
      patientId: input.patientId,
      relatedPatientId: input.relatedPatientId,
      kind: input.kind,
    },
  });
}

export async function removeRelationDb(relationId: string): Promise<void> {
  const session = await getSession();
  await prisma.patientRelation.deleteMany({ where: { id: relationId, companyId: session.companyId } });
}

/**
 * Отметить просмотр карточки пациента.
 *
 * §7 прямо требует аудит-лог на просмотр карточки: медицинские данные, и
 * должно быть видно, кто их открывал. В журнале не было ни одной такой
 * записи — только изменения настроек.
 *
 * Пишем не чаще раза в час на пациента: карточка перерисовывается при каждой
 * правке, и без этого журнал забился бы одинаковыми строками, в которых
 * ничего не найти.
 */
export async function logPatientView(patientId: string): Promise<void> {
  const session = await getSession();
  if (!session.userId) return;

  const hourAgo = new Date(Date.now() - 3600_000);
  const recent = await prisma.auditLog.findFirst({
    where: {
      companyId: session.companyId,
      actorId: session.userId,
      action: "PATIENT_VIEW",
      entityId: patientId,
      createdAt: { gte: hourAgo },
    },
    select: { id: true },
  });
  if (recent) return;

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "PATIENT_VIEW",
    entityType: "patient",
    entityId: patientId,
  }).catch(() => {});
}

/**
 * Сводка по базе пациентов для верхней панели раздела.
 *
 * Считается на сервере, а не в браузере. Прежде эти числа брались из стора,
 * который наполняется списком пациентов, — а список не содержит ни визитов,
 * ни курсов. Отсюда «с визитами 1 из 1794» при полутора тысячах пациентов с
 * историей и «средний интервал 0 дней»: считать было не по чему.
 */
export interface PatientsOverview {
  total: number;
  /** Первый контакт сегодня — по этому же правилу ставится метка «первичный». */
  primaryToday: number;
  withVisits: number;
  avgIntervalDays: number | null;
  noConsent: number;
  bySource: { source: string; count: number }[];
}

export async function getPatientsOverview(): Promise<PatientsOverview> {
  const session = await getSession();
  const companyId = session.companyId;
  // Полночь клиники, а не сервера: на UTC-хостинге «сегодня» начиналось в 03:00.
  const startOfToday = startOfClinicDay();

  const [total, primaryToday, withVisits, noConsent, sources, intervals] = await Promise.all([
    prisma.patient.count({ where: { companyId, deletedAt: null } }),
    prisma.patient.count({
      where: {
        companyId,
        deletedAt: null,
        // Карточки, перенесённые из YCLIENTS без визитов, новыми не считаются:
        // дату первого обращения у них взять было неоткуда (§8).
        firstSeenExact: true,
        firstSeenAt: { gte: startOfToday },
      },
    }),
    /**
     * «С визитами» — у кого визит СОСТОЯЛСЯ.
     *
     * Считались любые записи, включая отменённые и неявки: пациент, чью
     * единственную запись отменили, числился побывавшим в клинике. После
     * уборки исчезнувших из YCLIENTS записей таких стало заметно больше.
     */
    prisma.patient.count({
      where: { companyId, deletedAt: null, appointments: { some: { deletedAt: null, status: "ARRIVED" } } },
    }),
    prisma.patient.count({
      where: {
        companyId,
        deletedAt: null,
        notes: { some: { kind: "NO_CONSENT", resolvedAt: null } },
      },
    }),
    prisma.patient.groupBy({
      by: ["sourceId"],
      where: { companyId, deletedAt: null },
      _count: { _all: true },
    }),
    /**
     * Средний интервал между состоявшимися визитами по клинике.
     *
     * Считаем в базе: тянуть пять тысяч визитов в приложение ради одного
     * числа незачем. Берём разницу между соседними визитами одного пациента.
     */
    prisma.$queryRaw<{ avg: number | null }[]>`
      SELECT AVG(EXTRACT(EPOCH FROM diff) / 86400)::float AS avg
        FROM (
          SELECT "startAt" - LAG("startAt") OVER (PARTITION BY "patientId" ORDER BY "startAt") AS diff
            FROM appointments
           WHERE "companyId" = ${companyId} AND "deletedAt" IS NULL AND status = 'ARRIVED'
        ) gaps
       WHERE diff IS NOT NULL
    `,
  ]);

  const titles = new Map(
    (await prisma.source.findMany({ where: { companyId }, select: { id: true, title: true } })).map((s) => [
      s.id,
      s.title,
    ]),
  );

  const avg = intervals[0]?.avg;
  return {
    total,
    primaryToday,
    withVisits,
    avgIntervalDays: typeof avg === "number" && Number.isFinite(avg) ? Math.round(avg) : null,
    noConsent,
    bySource: sources
      .map((s) => ({
        // Пациенты из выгрузки YCLIENTS источника не имеют: там его нет.
        // Пишем это прямо, а не прочерком — прочерк выглядит как потеря данных.
        source: s.sourceId ? (titles.get(s.sourceId) ?? "—") : "Из YCLIENTS",
        count: s._count._all,
      }))
      .sort((a, b) => b.count - a.count),
  };
}
