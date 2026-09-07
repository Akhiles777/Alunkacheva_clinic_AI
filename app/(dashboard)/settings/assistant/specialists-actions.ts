"use server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/authz";
import { writeAudit } from "@/lib/server/audit";
import { normalizePhone } from "@/lib/phone";

/**
 * Кому ассистент пересылает вопросы, на которые не имеет права отвечать сам.
 *
 * Живёт в доменной таблице, а не в JSON-настройке: по номеру идёт маршрутизация
 * входящих сообщений на каждом сообщении WhatsApp, и это должен быть индекс, а
 * не разбор JSON.
 */
export interface SpecialistItem {
  id: string;
  name: string;
  phone: string;
  role: string;
  isDoctor: boolean;
  isManager: boolean;
  isActive: boolean;
  /** Сколько вопросов ему уходило и на сколько он ответил — видно пользу. */
  asked: number;
  answered: number;
}

export async function getSpecialists(): Promise<SpecialistItem[]> {
  const session = await getSession();
  const rows = await prisma.clinicSpecialist.findMany({
    where: { companyId: session.companyId },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { queries: true } } },
  });

  const answered = await prisma.specialistQuery.groupBy({
    by: ["specialistId"],
    where: { companyId: session.companyId, status: "ANSWERED" },
    _count: { _all: true },
  });
  const answeredBy = new Map(answered.map((a) => [a.specialistId, a._count._all]));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    role: r.role ?? "",
    isDoctor: r.isDoctor,
    isManager: r.isManager,
    isActive: r.isActive,
    asked: r._count.queries,
    answered: answeredBy.get(r.id) ?? 0,
  }));
}

export interface SpecialistDraft {
  id?: string;
  name: string;
  phone: string;
  role?: string;
  isDoctor: boolean;
  isManager: boolean;
  isActive: boolean;
}

export async function saveSpecialist(
  draft: SpecialistDraft,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");

  const name = draft.name.trim();
  if (!name) return { ok: false, error: "Без имени нельзя: его увидит администратор в уведомлении" };

  /**
   * Телефон нормализуется в E.164 на входе, всегда (§4).
   *
   * По нему узнаётся входящее сообщение специалиста. Номер, записанный как
   * «8 929 874-17-78», не совпал бы ни с чем, и её ответ ушёл бы в пациентский
   * инбокс — то есть функция молча не работала бы.
   */
  const phone = normalizePhone(draft.phone);
  if (!phone) return { ok: false, error: "Не разобрали номер. Формат: +7 929 874-17-78" };

  if (!draft.isDoctor && !draft.isManager) {
    return { ok: false, error: "Отметьте, какие вопросы пересылать: медицинские, деловые или оба" };
  }

  const twin = await prisma.clinicSpecialist.findFirst({
    where: { companyId: session.companyId, phone, ...(draft.id ? { NOT: { id: draft.id } } : {}) },
    select: { name: true },
  });
  if (twin) return { ok: false, error: `Этот номер уже записан за «${twin.name}»` };

  const data = {
    name,
    phone,
    role: draft.role?.trim() || null,
    isDoctor: draft.isDoctor,
    isManager: draft.isManager,
    isActive: draft.isActive,
  };

  const saved = draft.id
    ? await prisma.clinicSpecialist.update({ where: { id: draft.id }, data, select: { id: true } })
    : await prisma.clinicSpecialist.create({
        data: { companyId: session.companyId, ...data },
        select: { id: true },
      });

  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "clinic_specialist",
    entityId: saved.id,
  });
  return { ok: true, id: saved.id };
}

/**
 * Удаление специалиста.
 *
 * Вопросы к нему при этом исчезают каскадом — так и задумано: без адресата
 * они ничего не значат. Если переписку надо сохранить, специалиста выключают,
 * а не удаляют, и это видно на экране.
 */
export async function deleteSpecialist(id: string): Promise<{ ok: true }> {
  const session = await getSession();
  await requirePermission(session, "EDIT_SETTINGS");
  await prisma.clinicSpecialist.deleteMany({ where: { id, companyId: session.companyId } });
  await writeAudit({
    companyId: session.companyId,
    actorId: session.userId,
    action: "SETTINGS_UPDATE",
    entityType: "clinic_specialist",
    entityId: id,
  });
  return { ok: true };
}
