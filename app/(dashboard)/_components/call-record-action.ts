"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { normalizePhone } from "@/lib/phone";

/**
 * Занесение звонка в БД (доменная таблица CallLog). Звонок — обращение наравне с
 * сообщением (§3.4). Пациент матчится по нормализованному E.164 (единственный
 * надёжный ключ, §4); не нашли и передали имя — заводим пациента с этим номером.
 *
 * Пишет реальную запись параллельно с клиентским стором (write-through на время
 * миграции доменного слоя): БД накапливает достоверные CallLog и пациентов,
 * экраны пока читают стор.
 */
export interface RecordCallInput {
  phone: string;
  direction: "in" | "out";
  serviceId: string | null;
  sourceTitle: string | null;
  note: string;
  createNamed?: string;
}

export async function recordCall(
  input: RecordCallInput,
): Promise<{ patientId: string | null; matched: boolean }> {
  const session = await getSession();
  const e164 = normalizePhone(input.phone) ?? input.phone.trim();

  // Матчинг пациента по номеру.
  const existingPhone = await prisma.patientPhone.findFirst({
    where: { companyId: session.companyId, phone: e164 },
    select: { patientId: true },
  });
  let patientId = existingPhone?.patientId ?? null;
  const matched = patientId !== null;

  // Не нашли, но администратор ввёл имя — заводим пациента и номер.
  if (!patientId && input.createNamed && input.createNamed.trim().length >= 2) {
    const sourceId = await resolveSourceId(session.companyId, input.sourceTitle);
    const created = await prisma.patient.create({
      data: {
        companyId: session.companyId,
        name: input.createNamed.trim(),
        firstSeenAt: new Date(),
        sourceId,
        phones: {
          create: { companyId: session.companyId, phone: e164, isPrimary: true },
        },
      },
    });
    patientId = created.id;
  }

  const sourceId = await resolveSourceId(session.companyId, input.sourceTitle);
  const serviceId =
    input.serviceId &&
    (await prisma.service.findFirst({
      where: { id: input.serviceId, companyId: session.companyId },
      select: { id: true },
    }))
      ? input.serviceId
      : null;

  await prisma.callLog.create({
    data: {
      companyId: session.companyId,
      patientId,
      phone: e164,
      direction: input.direction === "in" ? "IN" : "OUT",
      serviceInterestId: serviceId,
      sourceId,
      note: input.note.trim() || null,
      createdById: session.userId,
    },
  });

  return { patientId, matched };
}

async function resolveSourceId(companyId: string, title: string | null): Promise<string | null> {
  if (!title) return null;
  const src = await prisma.source.findFirst({
    where: { companyId, title },
    select: { id: true },
  });
  return src?.id ?? null;
}
