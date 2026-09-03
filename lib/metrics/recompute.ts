import { prisma } from "@/lib/db";
import { classifyPatientVisits, type VisitInput } from "./visits";
import {
  attributeSource,
  LOOKAHEAD_MS,
  LOOKBACK_DAYS,
  type DialogTouch,
} from "./source-attribution";

/**
 * Пересчёт производных полей визита: первичный он или повторный.
 *
 * Зачем отдельный шаг. Классификация визитов (§8) была написана и покрыта
 * тестами, но не вызывалась ниоткуда: `isFirstVisit` оставался значением по
 * умолчанию, `visitKind` — пустым. После выгрузки из YCLIENTS это выглядело
 * так, будто первичных пациентов в клинике нет вовсе, а отчёты по услугам и
 * кабинетам пусты.
 *
 * Считать на лету нельзя: первичность визита зависит от всей истории
 * пациента, а не от самого визита. Отменённый задним числом визит убирает
 * себя из истории, и первичным становится следующий — значит пересчитывать
 * нужно всю историю пациента целиком, а не отдельную запись.
 *
 * Порядок: выгрузка → пересчёт. Иначе метрики врут ровно до следующего
 * пересчёта, а заметить это можно только по глазам администратора.
 */

/** Сколько пациентов берём за раз: вся история клиники в память не влезет. */
const PATIENT_BATCH = 200;

export interface RecomputeResult {
  patients: number;
  updated: number;
}

/**
 * Проставить кабинет визитам, у которых его нет, по кабинету специалиста.
 *
 * Клиника не ведёт кабинеты в YCLIENTS как ресурсы, поэтому в выгруженных
 * записях кабинета нет вовсе. Привязку задаёт администратор в «Настройки →
 * Сотрудники», но задать её он может уже после выгрузки — гонять всю историю
 * заново ради одного поля незачем.
 *
 * Трогаем только визиты без кабинета: проставленный вручную или пришедший из
 * YCLIENTS не перезаписываем.
 */
export async function backfillRooms(companyId: string): Promise<number> {
  const staff = await prisma.staff.findMany({
    where: { companyId, defaultRoomId: { not: null } },
    select: { id: true, defaultRoomId: true },
  });

  let updated = 0;
  for (const s of staff) {
    const res = await prisma.appointment.updateMany({
      where: { companyId, staffId: s.id, roomId: null, deletedAt: null },
      data: { roomId: s.defaultRoomId },
    });
    updated += res.count;
  }
  return updated;
}

/**
 * Дата первого обращения — не позже первого визита.
 *
 * Выгрузка ставила её «сейчас», и полторы тысячи человек с многолетней
 * историей разом стали первичными: на экране пациентов «первый контакт
 * сегодня» показывал всю базу. Правка в разборе чинит будущие выгрузки, но
 * уже загруженные строки надо поправить — иначе метка держится до следующей
 * полной выгрузки.
 *
 * Двигаем только назад: если у пациента первый визит раньше записанной даты,
 * значит он обратился тогда. Вперёд не двигаем никогда — это стёрло бы
 * реальную дату первого контакта из переписки.
 */
export async function backfillFirstSeen(companyId: string): Promise<number> {
  return prisma.$executeRaw`
    UPDATE patients p
       SET "firstSeenAt" = v.first_visit,
           -- Визит нашёлся — дата стала известной, метка неточности снимается.
           "firstSeenExact" = true
      FROM (
        SELECT "patientId", MIN("startAt") AS first_visit
          FROM appointments
         WHERE "companyId" = ${companyId} AND "deletedAt" IS NULL
         GROUP BY "patientId"
      ) v
     WHERE p.id = v."patientId"
       AND p."companyId" = ${companyId}
       AND p."firstSeenAt" > v.first_visit
  `;
}

/**
 * Пересчитать первичность визитов.
 *
 * `patientIds` сужает пересчёт до названных пациентов. Это для короткого круга
 * выгрузки: он читает пару дней, и гонять ради них всю базу — впустую. Полный
 * круг по-прежнему идёт по всем: пациента могли слить, визит — перенести на
 * год назад, и такие изменения видны только на всей истории.
 *
 * История каждого названного пациента читается целиком: первичность зависит от
 * всех его визитов, а не от тех, что попали в окно.
 */
export async function recomputeVisitKinds(
  companyId: string,
  patientIds?: string[],
): Promise<RecomputeResult> {
  if (patientIds && patientIds.length === 0) return { patients: 0, updated: 0 };
  const patients = await prisma.patient.findMany({
    where: { companyId, deletedAt: null, ...(patientIds ? { id: { in: patientIds } } : {}) },
    select: { id: true },
  });

  let updated = 0;

  for (let i = 0; i < patients.length; i += PATIENT_BATCH) {
    const chunk = patients.slice(i, i + PATIENT_BATCH);
    const ids = chunk.map((p) => p.id);

    const appts = await prisma.appointment.findMany({
      where: { companyId, patientId: { in: ids }, deletedAt: null },
      select: {
        id: true,
        patientId: true,
        startAt: true,
        status: true,
        courseId: true,
        isFirstVisit: true,
        visitKind: true,
      },
      orderBy: { startAt: "asc" },
    });

    const byPatient = new Map<string, typeof appts>();
    for (const a of appts) {
      const list = byPatient.get(a.patientId);
      if (list) list.push(a);
      else byPatient.set(a.patientId, [a]);
    }

    /**
     * Обновляем только те записи, у которых значение действительно меняется.
     * На повторном пересчёте это превращает тысячи запросов в ноль.
     */
    const changes: { id: string; isFirstVisit: boolean; visitKind: "FIRST" | "COURSE_SESSION" | "RETURN" | null }[] = [];

    for (const [, list] of byPatient) {
      const input: VisitInput[] = list.map((a) => ({
        appointmentId: a.id,
        startAt: a.startAt,
        status: a.status,
        courseId: a.courseId,
      }));
      for (const c of classifyPatientVisits(input)) {
        const current = list.find((a) => a.id === c.appointmentId);
        if (!current) continue;
        const isFirst = c.kind === "FIRST";
        if (current.isFirstVisit === isFirst && current.visitKind === c.kind) continue;
        changes.push({ id: c.appointmentId, isFirstVisit: isFirst, visitKind: c.kind });
      }
    }

    for (const change of changes) {
      await prisma.appointment.update({
        where: { id: change.id },
        data: { isFirstVisit: change.isFirstVisit, visitKind: change.visitKind },
      });
    }
    updated += changes.length;
  }

  return { patients: patients.length, updated };
}

/**
 * Откуда пришёл пациент: вывод источника визита из переписки.
 *
 * Источник в YCLIENTS не проставлен ни у одного визита — администраторы это
 * поле не заполняют. Вся воронка по источникам показывала одну строку
 * «источник не указан», то есть не показывала ничего.
 *
 * Переписка есть только у нас, и она отвечает на вопрос честно: человек,
 * писавший в WhatsApp за неделю до записи, пришёл из WhatsApp. Где переписки
 * рядом нет — источник остаётся неизвестным. Подставлять «звонок» нельзя:
 * отсутствие сообщения не доказывает звонок (§8, правило «догадка не факт»).
 *
 * Пересчёт идемпотентен: на неизменных данных не делает ни одного UPDATE.
 */
export interface SourceRecomputeResult {
  /** Сколько визитов рассмотрено (ручные сюда не входят — их не трогаем). */
  scanned: number;
  /** Источник выведен из переписки. */
  derived: number;
  /** Выведенный ранее источник пришлось снять: переписка больше не подходит. */
  cleared: number;
  /** Визитов с ручным источником — их пересчёт обошёл стороной. */
  manualKept: number;
  /** Осталось без источника после пересчёта. */
  unknown: number;
}

export async function recomputeAppointmentSources(
  companyId: string,
  patientIds?: string[],
): Promise<SourceRecomputeResult> {
  const empty: SourceRecomputeResult = {
    scanned: 0,
    derived: 0,
    cleared: 0,
    manualKept: 0,
    unknown: 0,
  };
  if (patientIds && patientIds.length === 0) return empty;

  const scope = {
    companyId,
    deletedAt: null,
    ...(patientIds ? { patientId: { in: patientIds } } : {}),
  } as const;

  /**
   * Ручные не читаем вовсе — только считаем.
   *
   * Администратор, проставивший источник руками, знает больше нас: он говорил
   * с человеком. Пересчёт, переписывающий такую отметку, обесценивает саму
   * возможность её поставить — второй раз её никто вводить не станет.
   */
  const manualKept = await prisma.appointment.count({
    where: { ...scope, sourceConfidence: "MANUAL" },
  });

  const appts = await prisma.appointment.findMany({
    where: { ...scope, sourceConfidence: { not: "MANUAL" } },
    select: {
      id: true,
      patientId: true,
      createdAtYclients: true,
      sourceId: true,
      sourceConfidence: true,
    },
  });
  if (appts.length === 0) return { ...empty, manualKept };

  const patients = [...new Set(appts.map((a) => a.patientId))];

  /**
   * Источник канала. У диалога он обычно проставлен при создании, но у старых
   * записей бывает пуст — тогда берём по коду канала. Кода нет в справочнике —
   * диалог в вывод не идёт: выдумывать источник не из чего.
   */
  const sources = await prisma.source.findMany({
    where: { companyId },
    select: { id: true, code: true },
  });
  const sourceByCode = new Map(sources.map((s) => [s.code, s.id]));

  const conversations = await prisma.conversation.findMany({
    where: { companyId, patientId: { in: patients }, deletedAt: null },
    select: { id: true, patientId: true, channel: true, sourceId: true },
  });

  const dialogSource = new Map<string, string>();
  const dialogPatient = new Map<string, string>();
  for (const c of conversations) {
    const sourceId = c.sourceId ?? sourceByCode.get(c.channel.toLowerCase()) ?? null;
    if (!sourceId || !c.patientId) continue;
    dialogSource.set(c.id, sourceId);
    dialogPatient.set(c.id, c.patientId);
  }

  /**
   * Сообщения пациентов в окне вокруг самой ранней и самой поздней записи.
   * Читаем одним запросом: ходить в базу за каждым визитом — сотни запросов
   * каждой выгрузкой.
   */
  const byPatient = new Map<string, DialogTouch[]>();
  if (dialogSource.size > 0) {
    // Границы окна — свёрткой, а не спредом: `Math.min(...массив)` на истории
    // в десятки тысяч записей упирается в предел аргументов вызова.
    let first = Infinity;
    let last = -Infinity;
    for (const a of appts) {
      const t = a.createdAtYclients.getTime();
      if (t < first) first = t;
      if (t > last) last = t;
    }
    const from = new Date(first - LOOKBACK_DAYS * 24 * 3600 * 1000);
    const to = new Date(last + LOOKAHEAD_MS);

    const messages = await prisma.message.findMany({
      where: {
        conversationId: { in: [...dialogSource.keys()] },
        direction: "IN",
        deletedAt: null,
        isDraft: false,
        createdAt: { gte: from, lte: to },
      },
      select: { conversationId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    for (const m of messages) {
      const patientId = dialogPatient.get(m.conversationId);
      const sourceId = dialogSource.get(m.conversationId);
      if (!patientId || !sourceId) continue;
      const list = byPatient.get(patientId);
      const touch: DialogTouch = {
        conversationId: m.conversationId,
        sourceId,
        messageAt: m.createdAt,
      };
      if (list) list.push(touch);
      else byPatient.set(patientId, [touch]);
    }
  }

  const now = new Date();
  const result: SourceRecomputeResult = { ...empty, scanned: appts.length, manualKept };

  for (const a of appts) {
    const verdict = attributeSource({
      createdAt: a.createdAtYclients,
      current: { sourceId: a.sourceId, confidence: a.sourceConfidence },
      touches: byPatient.get(a.patientId) ?? [],
    });

    if (verdict.confidence === "DERIVED") result.derived += 1;
    else result.unknown += 1;

    if (!verdict.changed) continue;
    if (verdict.confidence === "UNKNOWN" && a.sourceConfidence === "DERIVED") result.cleared += 1;

    /**
     * `conversationId` визита не трогаем сознательно: там живёт атрибуция
     * «запись создана из диалога» (§8, «пришло из переписки»). Рядом идущая
     * переписка — это не то же самое, и подмена завысила бы заслугу агента.
     */
    await prisma.appointment.update({
      where: { id: a.id },
      data: {
        sourceId: verdict.sourceId,
        sourceConfidence: verdict.confidence,
        sourceDerivedAt: verdict.confidence === "DERIVED" ? now : null,
      },
    });
  }

  return result;
}
