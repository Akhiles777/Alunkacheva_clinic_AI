"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
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

export async function getPatientRecords(): Promise<PatientRecord[]> {
  const session = await getSession();
  const patients = await prisma.patient.findMany({
    where: { companyId: session.companyId, deletedAt: null },
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
  await prisma.patient.create({
    data: {
      id: input.id,
      companyId: session.companyId,
      name: input.name.trim(),
      firstSeenAt: new Date(),
      sourceId,
      phones:
        input.e164 && input.phoneId
          ? { create: { id: input.phoneId, companyId: session.companyId, phone: input.e164, isPrimary: true } }
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
  await prisma.patientPhone.create({
    data: {
      id: input.id,
      companyId: session.companyId,
      patientId: input.patientId,
      phone: input.e164,
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
