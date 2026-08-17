import { prisma } from "@/lib/db";
import { classifyPatientVisits, type VisitInput } from "./visits";

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

export async function recomputeVisitKinds(companyId: string): Promise<RecomputeResult> {
  const patients = await prisma.patient.findMany({
    where: { companyId, deletedAt: null },
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
