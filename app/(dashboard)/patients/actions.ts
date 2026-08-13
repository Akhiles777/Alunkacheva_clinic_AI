"use server";

import { prisma } from "@/lib/db";
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
export interface PatientRecord {
  id: string;
  name: string;
  source: string | null;
  firstSeenToday: boolean;
  phones: { id: string; e164: string; label: string | null; isPrimary: boolean; whatsapp: boolean }[];
  notes: { id: string; kind: PatientNoteKind; text: string; resolved: boolean }[];
  relations: { id: string; relatedPatientId: string; kind: PatientRelationKind }[];
}

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
    },
  });
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return patients.map((p) => ({
    id: p.id,
    name: p.name ?? "",
    source: p.source?.title ?? null,
    firstSeenToday: p.firstSeenAt >= startOfToday,
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
    },
  });
  if (!p) return null;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return {
    id: p.id,
    name: p.name ?? "",
    source: p.source?.title ?? null,
    firstSeenToday: p.firstSeenAt >= startOfToday,
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

export async function softDeletePatient(id: string): Promise<void> {
  const session = await getSession();
  await prisma.patient.updateMany({
    where: { id, companyId: session.companyId },
    data: { deletedAt: new Date() },
  });
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
